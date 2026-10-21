package indexer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"
)

type Command string

const (
	StatusCommand Command = "status"
	StopCommand   Command = "stop"
)

type Server struct {
	manager *Manager
}

type controlRequest struct {
	Command Command `json:"command"`
}

type controlResponse struct {
	Status Status `json:"status"`
	Error  string `json:"error,omitempty"`
}

func NewServer(manager *Manager) *Server {
	return &Server{manager: manager}
}

func (server *Server) Serve(root string) error {
	if server == nil || server.manager == nil {
		return fmt.Errorf("serve workspace indexer: manager is required")
	}
	status, err := server.manager.Start(root)
	if err != nil {
		return err
	}
	if err := os.Remove(status.Endpoint); err != nil && !os.IsNotExist(err) {
		_ = server.manager.Stop(status.Workspace)
		return fmt.Errorf("serve workspace indexer: remove control endpoint: %w", err)
	}
	listener, err := net.Listen("unix", status.Endpoint)
	if err != nil {
		_ = server.manager.Stop(status.Workspace)
		return fmt.Errorf("serve workspace indexer: listen on control endpoint: %w", err)
	}
	defer func() {
		_ = listener.Close()
		_ = os.Remove(status.Endpoint)
		_ = server.manager.Stop(status.Workspace)
	}()

	for {
		current, found, err := server.manager.Status(status.Workspace)
		if err != nil {
			return err
		}
		if !found {
			return nil
		}
		deadlineListener, ok := listener.(interface {
			SetDeadline(time.Time) error
		})
		if !ok {
			return fmt.Errorf("serve workspace indexer: control listener does not support idle deadlines")
		}
		if err := deadlineListener.SetDeadline(current.IdleDeadline); err != nil {
			return fmt.Errorf("serve workspace indexer: set idle deadline: %w", err)
		}
		connection, err := listener.Accept()
		if err != nil {
			if isClosedConnectionError(err) {
				return nil
			}
			if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
				return nil
			}
			return fmt.Errorf("serve workspace indexer: accept control request: %w", err)
		}
		if server.handle(connection, status.Workspace) {
			return nil
		}
	}
}

func (server *Server) handle(connection net.Conn, root string) bool {
	defer connection.Close()
	var request controlRequest
	if err := json.NewDecoder(connection).Decode(&request); err != nil {
		_ = json.NewEncoder(connection).Encode(controlResponse{Error: fmt.Sprintf("decode control request: %v", err)})
		return false
	}

	status, found, err := server.manager.Touch(root)
	if err != nil {
		_ = json.NewEncoder(connection).Encode(controlResponse{Error: err.Error()})
		return false
	}
	if !found {
		_ = json.NewEncoder(connection).Encode(controlResponse{Error: "workspace indexer is not running"})
		return false
	}
	switch request.Command {
	case StatusCommand:
		_ = json.NewEncoder(connection).Encode(controlResponse{Status: status})
		return false
	case StopCommand:
		if err := json.NewEncoder(connection).Encode(controlResponse{Status: status}); err != nil {
			return false
		}
		return true
	default:
		_ = json.NewEncoder(connection).Encode(controlResponse{Error: fmt.Sprintf("unsupported control command %q", request.Command)})
		return false
	}
}

func Request(ctx context.Context, root string, command Command) (Status, error) {
	workspace, err := filepath.Abs(root)
	if err != nil {
		return Status{}, fmt.Errorf("request workspace indexer: resolve workspace root: %w", err)
	}
	endpoint := filepath.Join(workspace, stateDirectory, endpointName)
	connection, err := (&net.Dialer{}).DialContext(ctx, "unix", endpoint)
	if err != nil {
		return Status{}, fmt.Errorf("request workspace indexer: connect to control endpoint: %w", err)
	}
	defer connection.Close()
	if err := json.NewEncoder(connection).Encode(controlRequest{Command: command}); err != nil {
		return Status{}, fmt.Errorf("request workspace indexer: encode control request: %w", err)
	}
	var response controlResponse
	if err := json.NewDecoder(connection).Decode(&response); err != nil {
		return Status{}, fmt.Errorf("request workspace indexer: decode control response: %w", err)
	}
	if response.Error != "" {
		return Status{}, fmt.Errorf("request workspace indexer: %s", response.Error)
	}
	return response.Status, nil
}

func isClosedConnectionError(err error) bool {
	return errors.Is(err, net.ErrClosed) || os.IsNotExist(err)
}

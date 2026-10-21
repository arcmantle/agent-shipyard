package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"agent-wayfinder/storage"
)

type Format string

const (
	FormatText Format = "text"
	FormatJSON Format = "json"
)

type ErrorKind string

const (
	ErrorInvalidArgument  ErrorKind = "invalid_argument"
	ErrorIndexUnavailable ErrorKind = "index_unavailable"
)

type CommandError struct {
	Kind    ErrorKind
	Message string
}

func (err *CommandError) Error() string {
	return err.Message
}

func ParseFormat(value string) (Format, error) {
	switch value {
	case "", string(FormatText):
		return FormatText, nil
	case string(FormatJSON):
		return FormatJSON, nil
	default:
		return "", NewInvalidArgumentError(fmt.Sprintf("unsupported output format %q; expected text or json", value))
	}
}

func NewInvalidArgumentError(message string) error {
	return &CommandError{Kind: ErrorInvalidArgument, Message: message}
}

func NewIndexUnavailableError(workspace string) error {
	return &CommandError{
		Kind:    ErrorIndexUnavailable,
		Message: fmt.Sprintf("no published graph is available for workspace %q", workspace),
	}
}

func ExitCode(err error) int {
	if err == nil {
		return 0
	}
	var commandError *CommandError
	if errors.As(err, &commandError) && commandError.Kind == ErrorInvalidArgument {
		return 2
	}
	return 1
}

func RenderError(writer io.Writer, err error) error {
	if err == nil {
		return nil
	}
	if _, writeErr := fmt.Fprintf(writer, "error: %s\n", err); writeErr != nil {
		return fmt.Errorf("render command error: %w", writeErr)
	}
	return nil
}

type Result struct {
	Snapshot     storage.Snapshot
	OmitSnapshot bool
	Text         string
	Data         any
}

func Render(writer io.Writer, result Result, format Format) error {
	switch format {
	case FormatText:
		if result.OmitSnapshot {
			if _, err := fmt.Fprintf(writer, "%s\n", result.Text); err != nil {
				return fmt.Errorf("render text result: %w", err)
			}
			return nil
		}
		_, err := fmt.Fprintf(
			writer,
			"Graph version: %d\nPublished at: %s\n\n%s\n",
			result.Snapshot.Version,
			result.Snapshot.PublishedAt.UTC().Format("2006-01-02T15:04:05Z"),
			result.Text,
		)
		if err != nil {
			return fmt.Errorf("render text result: %w", err)
		}
		return nil
	case FormatJSON:
		if result.OmitSnapshot {
			envelope := struct {
				Result any `json:"result"`
			}{Result: result.Data}
			if err := json.NewEncoder(writer).Encode(envelope); err != nil {
				return fmt.Errorf("render JSON result: %w", err)
			}
			return nil
		}
		envelope := struct {
			GraphVersion storage.GraphVersion `json:"graphVersion"`
			PublishedAt  string               `json:"publishedAt"`
			Result       any                  `json:"result"`
		}{
			GraphVersion: result.Snapshot.Version,
			PublishedAt:  result.Snapshot.PublishedAt.UTC().Format("2006-01-02T15:04:05Z"),
			Result:       result.Data,
		}
		if err := json.NewEncoder(writer).Encode(envelope); err != nil {
			return fmt.Errorf("render JSON result: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("render result: unsupported format %q", format)
	}
}

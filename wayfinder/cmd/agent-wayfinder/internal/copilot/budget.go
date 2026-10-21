package copilot

import (
	"context"
	"errors"
	"fmt"
	"io"
)

var (
	ErrPromptBudgetExceeded   = errors.New("Copilot prompt exceeds token budget")
	ErrResponseBudgetExceeded = errors.New("Copilot response exceeds token budget")
	ErrPlannerTimeout         = errors.New("Copilot planner timed out")
)

func ReadResponse(ctx context.Context, prompt string, tokenBudget int, response io.ReadCloser) ([]byte, error) {
	promptTokens := EstimateTokens(prompt)
	if promptTokens >= tokenBudget {
		return nil, ErrPromptBudgetExceeded
	}

	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = response.Close()
		case <-done:
		}
	}()
	defer close(done)
	defer response.Close()

	remainingTokens := tokenBudget - promptTokens
	contents := make([]byte, 0, remainingTokens)
	buffer := make([]byte, 1024)
	for {
		count, err := response.Read(buffer)
		if count > remainingTokens {
			return nil, ErrResponseBudgetExceeded
		}
		if count > 0 {
			contents = append(contents, buffer[:count]...)
			remainingTokens -= count
		}
		if err == io.EOF {
			return contents, nil
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil, fmt.Errorf("%w: %w", ErrPlannerTimeout, ctx.Err())
			}
			return nil, fmt.Errorf("read Copilot planner response: %w", err)
		}
	}
}

func EstimateTokens(text string) int {
	return len(text)
}

package ask

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os/exec"

	"agent-wayfinder/cmd/agent-wayfinder/internal/claude"
	"agent-wayfinder/cmd/agent-wayfinder/internal/copilot"
	"agent-wayfinder/cmd/agent-wayfinder/internal/ollama"
	"agent-wayfinder/cmd/agent-wayfinder/internal/planning"
	"agent-wayfinder/cmd/agent-wayfinder/internal/spending"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
)

type graphPlannerFunc func(context.Context, query.GraphPlanningRequest) ([]string, error)

func (planner graphPlannerFunc) PlanGraphQueries(ctx context.Context, request query.GraphPlanningRequest) ([]string, error) {
	return planner(ctx, request)
}

func NewPlanner(workspaceRoot string, store storage.SpendReservationStore) (query.GraphPlanner, error) {
	provider, err := planning.ReadProvider(workspaceRoot)
	if err != nil {
		return nil, err
	}
	if provider == "" {
		return nil, fmt.Errorf("ask planning: set planning.provider to ollama, claude, or copilot")
	}
	if provider == planning.ProviderOllama {
		configuration, err := ollama.ReadConfiguration(workspaceRoot)
		if err != nil {
			return nil, err
		}
		return graphPlannerFunc(func(ctx context.Context, request query.GraphPlanningRequest) ([]string, error) {
			response, err := ollama.RunGraphPlanner(ctx, configuration, request, configuration.Endpoint, http.DefaultClient)
			if err != nil {
				return nil, err
			}
			return query.ParseGraphPlanningResponse(response)
		}), nil
	}
	budget, err := spending.ReadConfiguration(workspaceRoot)
	if err != nil {
		return nil, err
	}
	limits := budget.Copilot
	if provider == planning.ProviderClaude {
		limits = budget.Claude
	}
	if store == nil && (limits.Daily > 0 || limits.Weekly > 0 || limits.Monthly > 0) {
		return nil, fmt.Errorf("ask planning: a spending store is required for configured spending limits")
	}
	if provider == planning.ProviderClaude {
		configuration, err := claude.ReadConfiguration(workspaceRoot)
		if err != nil {
			return nil, err
		}
		return graphPlannerFunc(func(ctx context.Context, request query.GraphPlanningRequest) ([]string, error) {
			return planClaudeGraph(ctx, configuration, request, budget, store)
		}), nil
	}
	configuration, err := copilot.ReadConfiguration(workspaceRoot)
	if err != nil {
		return nil, err
	}
	return graphPlannerFunc(func(ctx context.Context, request query.GraphPlanningRequest) ([]string, error) {
		return planCopilotGraph(ctx, configuration, request, budget, store)
	}), nil
}

func planClaudeGraph(ctx context.Context, configuration claude.Configuration, request query.GraphPlanningRequest, budget spending.Configuration, store storage.SpendReservationStore) ([]string, error) {
	reservation, err := budget.Reserve(ctx, store, spending.ProviderClaude, configuration.MaxBudgetUSD, 0)
	if err != nil {
		return nil, fmt.Errorf("ask planning Claude spending limit: %w", err)
	}
	configuration.MaxBudgetUSD = reservation.Amount
	run, runErr := claude.RunGraphPlanner(ctx, configuration, request, exec.CommandContext)
	var candidates []string
	if runErr == nil {
		candidates, runErr = query.ParseGraphPlanningResponse(run.Response)
	}
	if run.CostUSD.Availability == storage.MetricValueExact {
		runErr = errors.Join(runErr, budget.Settle(context.WithoutCancel(ctx), store, reservation, run.CostUSD.Value))
	}
	if recorder, supported := store.(storage.ClaudePlannerMetricRecorder); supported {
		outcome := storage.ClaudePlannerOutcomeSuccess
		if runErr != nil {
			outcome = storage.ClaudePlannerOutcomeUnavailable
			if errors.Is(runErr, claude.ErrTimeout) {
				outcome = storage.ClaudePlannerOutcomeTimeout
			} else if errors.Is(runErr, claude.ErrBudgetExceeded) {
				outcome = storage.ClaudePlannerOutcomeBudget
			} else if errors.Is(runErr, claude.ErrModelUnavailable) {
				outcome = storage.ClaudePlannerOutcomeModelUnavailable
			}
		}
		runErr = errors.Join(runErr, recorder.RecordClaudePlannerMetric(context.WithoutCancel(ctx), claude.NewPlannerMetric(configuration, run, outcome)))
	}
	return candidates, runErr
}

func planCopilotGraph(ctx context.Context, configuration copilot.Configuration, request query.GraphPlanningRequest, budget spending.Configuration, store storage.SpendReservationStore) ([]string, error) {
	reservation, err := budget.Reserve(ctx, store, spending.ProviderCopilot, float64(configuration.MaxAICredits), copilot.MinimumAICredits)
	if err != nil {
		return nil, fmt.Errorf("ask planning Copilot spending limit: %w", err)
	}
	configuration.MaxAICredits = int(reservation.Amount)
	run, runErr := copilot.RunGraphPlanner(ctx, configuration, request, exec.CommandContext)
	var candidates []string
	if runErr == nil {
		candidates, runErr = query.ParseGraphPlanningResponse(run.Response)
	}
	if run.UsageAvailable {
		runErr = errors.Join(runErr, budget.Settle(context.WithoutCancel(ctx), store, reservation, float64(run.Usage.PremiumRequestCredits)))
	}
	if recorder, supported := store.(storage.CopilotPlannerMetricRecorder); supported {
		outcome := storage.CopilotPlannerOutcomeSuccess
		if runErr != nil {
			outcome = storage.CopilotPlannerOutcomeFailure
			if errors.Is(runErr, copilot.ErrPlannerTimeout) {
				outcome = storage.CopilotPlannerOutcomeTimeout
			}
		}
		runErr = errors.Join(runErr, recorder.RecordCopilotPlannerMetric(context.WithoutCancel(ctx), copilot.NewPlannerMetric(configuration, run, outcome)))
	}
	return candidates, runErr
}

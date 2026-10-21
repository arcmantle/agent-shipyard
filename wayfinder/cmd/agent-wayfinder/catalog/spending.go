package catalog

import (
	"context"
	"fmt"
	"os/exec"

	"agent-wayfinder/cmd/agent-wayfinder/internal/claude"
	"agent-wayfinder/cmd/agent-wayfinder/internal/copilot"
	"agent-wayfinder/cmd/agent-wayfinder/internal/spending"
	"agent-wayfinder/index"
	"agent-wayfinder/storage"
)

type spendingCatalogSynopsisGenerator struct {
	provider             index.CatalogSynopsisProvider
	configuration        spending.Configuration
	store                storage.SpendReservationStore
	copilotConfiguration copilot.CatalogConfiguration
	claudeConfiguration  claude.Configuration
}

func (generator spendingCatalogSynopsisGenerator) GenerateCatalogSynopsis(ctx context.Context, input index.CatalogSynopsisInput) (string, error) {
	switch generator.provider {
	case index.CatalogSynopsisProviderCopilot:
		reservation, err := generator.configuration.Reserve(ctx, generator.store, spending.ProviderCopilot, float64(generator.copilotConfiguration.MaxAICredits), copilot.MinimumAICredits)
		if err != nil {
			return "", fmt.Errorf("reserve Copilot synopsis spend: %w", err)
		}
		configuration := generator.copilotConfiguration
		configuration.MaxAICredits = int(reservation.Amount)
		run, err := copilot.RunCatalogSynopsisWithUsage(ctx, configuration, input, exec.CommandContext)
		if run.PremiumRequestCredits.Availability == storage.MetricValueExact {
			if settleErr := generator.configuration.Settle(ctx, generator.store, reservation, float64(run.PremiumRequestCredits.Value)); settleErr != nil {
				return "", settleErr
			}
		}
		return run.Synopsis, err
	case index.CatalogSynopsisProviderClaude:
		reservation, err := generator.configuration.Reserve(ctx, generator.store, spending.ProviderClaude, generator.claudeConfiguration.MaxBudgetUSD, 0)
		if err != nil {
			return "", fmt.Errorf("reserve Claude synopsis spend: %w", err)
		}
		configuration := generator.claudeConfiguration
		configuration.MaxBudgetUSD = reservation.Amount
		run, err := claude.RunCatalogSynopsis(ctx, configuration, input, exec.CommandContext)
		if run.CostUSD.Availability == storage.MetricValueExact {
			if settleErr := generator.configuration.Settle(ctx, generator.store, reservation, run.CostUSD.Value); settleErr != nil {
				return "", settleErr
			}
		}
		return run.Synopsis, err
	default:
		return "", fmt.Errorf("reserve catalog synopsis spend: unsupported provider %q", generator.provider)
	}
}

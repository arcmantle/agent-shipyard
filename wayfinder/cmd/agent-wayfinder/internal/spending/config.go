package spending

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"

	configpath "agent-wayfinder/cmd/agent-wayfinder/internal/configuration"
	"agent-wayfinder/storage"
)

const (
	ProviderCopilot = "copilot"
	ProviderClaude  = "claude"
)

type Limits struct {
	Daily   float64
	Weekly  float64
	Monthly float64
}

type Configuration struct {
	Copilot Limits
	Claude  Limits
}

type configurationFile struct {
	Copilot *struct {
		Daily   *float64 `json:"dailyAiCredits"`
		Weekly  *float64 `json:"weeklyAiCredits"`
		Monthly *float64 `json:"monthlyAiCredits"`
	} `json:"copilot"`
	Claude *struct {
		Daily   *float64 `json:"dailyUsd"`
		Weekly  *float64 `json:"weeklyUsd"`
		Monthly *float64 `json:"monthlyUsd"`
	} `json:"claude"`
}

func ReadConfiguration(workspaceRoot string) (Configuration, error) {
	configuration := Configuration{}
	for _, path := range configpath.Paths(workspaceRoot) {
		file, err := readConfigurationFile(path)
		if err != nil {
			return Configuration{}, err
		}
		applyConfiguration(&configuration, file)
	}
	if err := validateConfiguration(configuration); err != nil {
		return Configuration{}, err
	}
	return configuration, nil
}

func (configuration Configuration) Reserve(ctx context.Context, store storage.SpendReservationStore, provider string, maximumAmount, minimumAmount float64) (storage.SpendReservation, error) {
	if store == nil || !configuration.limits(provider).enabled() {
		return storage.SpendReservation{Amount: maximumAmount}, nil
	}
	return store.ReserveSpend(ctx, storage.SpendReservationRequest{
		Provider:      provider,
		Unit:          configuration.unit(provider),
		MaximumAmount: maximumAmount,
		MinimumAmount: minimumAmount,
		Limits: storage.SpendLimits{
			Daily:   configuration.limits(provider).Daily,
			Weekly:  configuration.limits(provider).Weekly,
			Monthly: configuration.limits(provider).Monthly,
		},
	})
}

func (configuration Configuration) Settle(ctx context.Context, store storage.SpendReservationStore, reservation storage.SpendReservation, exactAmount float64) error {
	if store == nil || reservation.ID == 0 {
		return nil
	}
	return store.SettleSpend(ctx, reservation.ID, exactAmount)
}

func (configuration Configuration) limits(provider string) Limits {
	if provider == ProviderClaude {
		return configuration.Claude
	}
	return configuration.Copilot
}

func (configuration Configuration) unit(provider string) string {
	if provider == ProviderClaude {
		return "usd"
	}
	return "ai_credits"
}

func (limits Limits) enabled() bool {
	return limits.Daily > 0 || limits.Weekly > 0 || limits.Monthly > 0
}

func readConfigurationFile(path string) (configurationFile, error) {
	contents, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return configurationFile{}, nil
	}
	if err != nil {
		return configurationFile{}, fmt.Errorf("read spending configuration: %w", err)
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(contents, &root); err != nil {
		return configurationFile{}, fmt.Errorf("parse spending configuration: %w", err)
	}
	raw, exists := root["spending"]
	if !exists {
		return configurationFile{}, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var configuration configurationFile
	if err := decoder.Decode(&configuration); err != nil {
		return configurationFile{}, fmt.Errorf("parse spending configuration: %w", err)
	}
	return configuration, nil
}

func applyConfiguration(configuration *Configuration, file configurationFile) {
	if file.Copilot != nil {
		applyLimits(&configuration.Copilot, file.Copilot.Daily, file.Copilot.Weekly, file.Copilot.Monthly)
	}
	if file.Claude != nil {
		applyLimits(&configuration.Claude, file.Claude.Daily, file.Claude.Weekly, file.Claude.Monthly)
	}
}

func applyLimits(limits *Limits, daily, weekly, monthly *float64) {
	if daily != nil {
		limits.Daily = *daily
	}
	if weekly != nil {
		limits.Weekly = *weekly
	}
	if monthly != nil {
		limits.Monthly = *monthly
	}
}

func validateConfiguration(configuration Configuration) error {
	for provider, limits := range map[string]Limits{ProviderCopilot: configuration.Copilot, ProviderClaude: configuration.Claude} {
		for period, limit := range map[string]float64{"daily": limits.Daily, "weekly": limits.Weekly, "monthly": limits.Monthly} {
			if limit < 0 || math.IsNaN(limit) || math.IsInf(limit, 0) {
				return fmt.Errorf("invalid %s %s spending limit: use a nonnegative number", provider, period)
			}
		}
	}
	return nil
}

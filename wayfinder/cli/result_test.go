package cli_test

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"agent-wayfinder/cli"
	"agent-wayfinder/storage"
)

func TestRenderTextIncludesSnapshotMetadata(t *testing.T) {
	var output bytes.Buffer
	snapshot := storage.Snapshot{
		Workspace:   "workspace",
		Version:     7,
		PublishedAt: time.Date(2026, time.August, 14, 12, 30, 0, 0, time.UTC),
	}

	err := cli.Render(&output, cli.Result{
		Snapshot: snapshot,
		Text:     "Found 1 node.",
	}, cli.FormatText)
	if err != nil {
		t.Fatalf("render text result: %v", err)
	}

	got := output.String()
	for _, want := range []string{
		"Graph version: 7",
		"Published at: 2026-08-14T12:30:00Z",
		"Found 1 node.",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("text result = %q, want %q", got, want)
		}
	}
}

func TestRenderJSONIncludesSnapshotMetadataAndData(t *testing.T) {
	var output bytes.Buffer
	snapshot := storage.Snapshot{
		Workspace:   "workspace",
		Version:     7,
		PublishedAt: time.Date(2026, time.August, 14, 12, 30, 0, 0, time.UTC),
	}

	err := cli.Render(&output, cli.Result{
		Snapshot: snapshot,
		Data:     map[string]int{"nodes": 1},
	}, cli.FormatJSON)
	if err != nil {
		t.Fatalf("render JSON result: %v", err)
	}

	var got struct {
		GraphVersion int            `json:"graphVersion"`
		PublishedAt  time.Time      `json:"publishedAt"`
		Result       map[string]int `json:"result"`
	}
	if err := json.Unmarshal(output.Bytes(), &got); err != nil {
		t.Fatalf("decode JSON result: %v", err)
	}
	if got.GraphVersion != 7 {
		t.Errorf("JSON graph version = %d, want 7", got.GraphVersion)
	}
	if !got.PublishedAt.Equal(snapshot.PublishedAt) {
		t.Errorf("JSON publication time = %s, want %s", got.PublishedAt, snapshot.PublishedAt)
	}
	if got.Result["nodes"] != 1 {
		t.Errorf("JSON result = %#v, want node count 1", got.Result)
	}
}

func TestParseFormatDefaultsToTextAndRejectsUnknownValues(t *testing.T) {
	format, err := cli.ParseFormat("")
	if err != nil {
		t.Fatalf("parse default format: %v", err)
	}
	if format != cli.FormatText {
		t.Errorf("default format = %q, want %q", format, cli.FormatText)
	}

	_, err = cli.ParseFormat("yaml")
	if err == nil {
		t.Fatal("parse unsupported format succeeded")
	}
	if got := cli.ExitCode(err); got == 0 {
		t.Errorf("invalid format exit code = %d, want nonzero", got)
	}
}

func TestRenderErrorReportsUnavailableIndex(t *testing.T) {
	var output bytes.Buffer
	err := cli.RenderError(&output, cli.NewIndexUnavailableError("workspace"))
	if err != nil {
		t.Fatalf("render unavailable index error: %v", err)
	}

	if got := output.String(); !strings.Contains(got, "no published graph is available for workspace \"workspace\"") {
		t.Errorf("unavailable index error = %q", got)
	}
	if got := cli.ExitCode(cli.NewIndexUnavailableError("workspace")); got == 0 {
		t.Errorf("unavailable index exit code = %d, want nonzero", got)
	}
}

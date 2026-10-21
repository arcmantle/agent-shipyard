package workspace_test

import (
	"context"
	"errors"
	"os"
	"reflect"
	"testing"

	"agent-wayfinder/testkit"
	"agent-wayfinder/workspace"
)

func TestDiscoverStreamMatchesMaterializedProjectOwnershipIgnoreRulesAndOrder(t *testing.T) {
	fixture := testkit.NewWorkspace(t, map[string]string{
		"package.json":                        `{"name":"root"}`,
		".wayfinderignore":                    "generated/\n!generated/keep.ts\n",
		"src/root.ts":                         "export const root = 1;\n",
		"generated/drop.ts":                   "export const drop = 1;\n",
		"generated/keep.ts":                   "export const keep = 1;\n",
		"packages/app/package.json":           `{"name":"app"}`,
		"packages/app/src/main.ts":            "export const main = 1;\n",
		"packages/utility/src/utility.js":     "export const utility = 1;\n",
		"packages/utility/src/unsupported.md": "not source\n",
	})
	options := workspace.DiscoverOptions{ConfiguredRoots: []string{"packages/utility"}}
	materialized, err := workspace.Discover(fixture.Root, options)
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}

	var streamed []workspace.Source
	projects, sourceCount, err := workspace.DiscoverStream(context.Background(), fixture.Root, options, func(source workspace.Source) error {
		streamed = append(streamed, source)
		return nil
	})
	if err != nil {
		t.Fatalf("stream workspace discovery: %v", err)
	}
	if !reflect.DeepEqual(projects, materialized.Projects) {
		t.Errorf("streamed projects = %#v, want %#v", projects, materialized.Projects)
	}
	if !reflect.DeepEqual(streamed, materialized.Sources) {
		t.Errorf("streamed sources = %#v, want %#v", streamed, materialized.Sources)
	}
	if sourceCount != len(materialized.Sources) {
		t.Errorf("streamed source count = %d, want %d", sourceCount, len(materialized.Sources))
	}
}

func TestDiscoverStreamStopsWhenContextIsCanceled(t *testing.T) {
	fixture := testkit.NewWorkspace(t, map[string]string{
		"package.json": "{}",
		"a.ts":         "export const a = 1;\n",
		"b.ts":         "export const b = 1;\n",
		"c.ts":         "export const c = 1;\n",
	})
	ctx, cancel := context.WithCancel(context.Background())
	emitted := 0
	_, _, err := workspace.DiscoverStream(ctx, fixture.Root, workspace.DiscoverOptions{}, func(workspace.Source) error {
		emitted++
		cancel()
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("stream workspace discovery error = %v, want context canceled", err)
	}
	if emitted != 1 {
		t.Errorf("emitted sources = %d, want 1", emitted)
	}
}

func TestDiscoverFindsNestedManifestProjectsAndAssignsSourcesToMostSpecificRoot(t *testing.T) {
	fixture := testkit.NewWorkspace(t, map[string]string{
		"package.json":                     `{"name":"root"}`,
		"src/root.ts":                      "export const root = 1;\n",
		"packages/app/package.json":        `{"name":"app"}`,
		"packages/app/src/main.ts":         "export const main = 1;\n",
		"packages/app/src/ignored.txt":     "not source\n",
		"packages/app/nested/secondary.ts": "export const secondary = 1;\n",
		"packages/utility/src/utility.js":  "export const utility = 1;\n",
		"packages/utility/README.md":       "not source\n",
	})

	first, err := workspace.Discover(fixture.Root, workspace.DiscoverOptions{})
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}
	second, err := workspace.Discover(fixture.Root, workspace.DiscoverOptions{})
	if err != nil {
		t.Fatalf("discover workspace again: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Errorf("discover result is not deterministic\nfirst: %#v\nsecond: %#v", first, second)
	}

	want := workspace.Discovery{
		Projects: []workspace.Project{
			{ID: "project:.", Root: "."},
			{ID: "project:packages/app", Root: "packages/app"},
		},
		Sources: []workspace.Source{
			{Path: "packages/app/nested/secondary.ts", ProjectID: "project:packages/app"},
			{Path: "packages/app/src/main.ts", ProjectID: "project:packages/app"},
			{Path: "packages/utility/src/utility.js", ProjectID: "project:."},
			{Path: "src/root.ts", ProjectID: "project:."},
		},
	}
	if !reflect.DeepEqual(first, want) {
		t.Errorf("discovery = %#v, want %#v", first, want)
	}
}

func TestDiscoverAddsConfiguredRootsAndPrefersThemOverAncestorProjects(t *testing.T) {
	fixture := testkit.NewWorkspace(t, map[string]string{
		"package.json":                    `{"name":"root"}`,
		"src/root.ts":                     "export const root = 1;\n",
		"packages/utility/src/utility.js": "export const utility = 1;\n",
	})

	discovery, err := workspace.Discover(fixture.Root, workspace.DiscoverOptions{
		ConfiguredRoots: []string{"packages/utility"},
	})
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}

	want := workspace.Discovery{
		Projects: []workspace.Project{
			{ID: "project:.", Root: "."},
			{ID: "project:packages/utility", Root: "packages/utility"},
		},
		Sources: []workspace.Source{
			{Path: "packages/utility/src/utility.js", ProjectID: "project:packages/utility"},
			{Path: "src/root.ts", ProjectID: "project:."},
		},
	}
	if !reflect.DeepEqual(discovery, want) {
		t.Errorf("discovery = %#v, want %#v", discovery, want)
	}
}

func TestDiscoverUsesTypeScriptAndJavaScriptManifestsWithOneIdentityPerRoot(t *testing.T) {
	fixture := testkit.NewWorkspace(t, map[string]string{
		"packages/app/package.json":    `{"name":"app"}`,
		"packages/app/tsconfig.json":   `{}`,
		"packages/app/src/main.ts":     "export const main = 1;\n",
		"packages/types/tsconfig.json": `{}`,
		"packages/types/src/types.ts":  "export type Item = string;\n",
		"packages/web/jsconfig.json":   `{}`,
		"packages/web/src/client.jsx":  "export const Client = () => null;\n",
	})

	discovery, err := workspace.Discover(fixture.Root, workspace.DiscoverOptions{
		ConfiguredRoots: []string{"packages/app"},
	})
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}

	want := workspace.Discovery{
		Projects: []workspace.Project{
			{ID: "project:packages/app", Root: "packages/app"},
			{ID: "project:packages/types", Root: "packages/types"},
			{ID: "project:packages/web", Root: "packages/web"},
		},
		Sources: []workspace.Source{
			{Path: "packages/app/src/main.ts", ProjectID: "project:packages/app"},
			{Path: "packages/types/src/types.ts", ProjectID: "project:packages/types"},
			{Path: "packages/web/src/client.jsx", ProjectID: "project:packages/web"},
		},
	}
	if !reflect.DeepEqual(discovery, want) {
		t.Errorf("discovery = %#v, want %#v", discovery, want)
	}
}

func TestDiscoverAppliesSourcesIncludeAndExcludeConfiguration(t *testing.T) {
	fixture := testkit.NewWorkspace(t, map[string]string{
		"package.json":                    `{"name":"root"}`,
		".agent-wayfinder/config.json":    `{"sources":{"include":["src/**/*.ts","packages/*/src/**/*.ts"],"exclude":["**/*.test.ts","**/generated/**"]}}`,
		"root-only.ts":                    "export const rootOnly = 1;\n",
		"src/main.ts":                     "export const main = 1;\n",
		"src/main.test.ts":                "export const test = 1;\n",
		"generated/build.ts":              "export const build = 1;\n",
		"packages/app/package.json":       `{"name":"app"}`,
		"packages/app/src/main.ts":        "export const main = 1;\n",
		"packages/app/generated/build.ts": "export const build = 1;\n",
		"node_modules/package/index.js":   "module.exports = {};\n",
		".agent-wayfinder/cache/index.ts": "export const cache = 1;\n",
		".git/hooks/ignored.ts":           "export const hook = 1;\n",
	})

	discovery, err := workspace.Discover(fixture.Root, workspace.DiscoverOptions{})
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}

	want := workspace.Discovery{
		Projects: []workspace.Project{{ID: "project:.", Root: "."}, {ID: "project:packages/app", Root: "packages/app"}},
		Sources: []workspace.Source{
			{Path: "packages/app/src/main.ts", ProjectID: "project:packages/app"},
			{Path: "src/main.ts", ProjectID: "project:."},
		},
	}
	if !reflect.DeepEqual(discovery, want) {
		t.Errorf("discovery = %#v, want %#v", discovery, want)
	}
}

func TestDiscoverWorkspaceSourceSelectionReplacesUserDefaultsAndIgnoresWayfinderignore(t *testing.T) {
	user := testkit.NewWorkspace(t, map[string]string{})
	user.WriteFile(t, ".agent-wayfinder/config.json", `{"sources":{"include":["src/**/*.ts"],"exclude":["**/client.ts"]}}`)
	t.Setenv("HOME", user.Root)
	t.Setenv("USERPROFILE", user.Root)
	fixture := testkit.NewWorkspace(t, map[string]string{
		"package.json":                    `{"name":"root"}`,
		".agent-wayfinder/config.json":    `{"sources":{"include":["packages/**/*.ts"],"exclude":[]}}`,
		".wayfinderignore":                "packages/\n",
		"src/main.ts":                     "export const main = 1;\n",
		"packages/app/package.json":       `{"name":"app"}`,
		"packages/app/src/client.ts":      "export const client = 1;\n",
		"packages/app/src/client.test.ts": "export const test = 1;\n",
	})

	discovery, err := workspace.Discover(fixture.Root, workspace.DiscoverOptions{})
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}

	want := []workspace.Source{
		{Path: "packages/app/src/client.test.ts", ProjectID: "project:packages/app"},
		{Path: "packages/app/src/client.ts", ProjectID: "project:packages/app"},
	}
	if !reflect.DeepEqual(discovery.Sources, want) {
		t.Errorf("sources = %#v, want %#v", discovery.Sources, want)
	}
}

func TestDiscoverExcludesSourcesIgnoredByGit(t *testing.T) {
	fixture := testkit.NewWorkspace(t, map[string]string{
		"package.json":     `{"name":"root"}`,
		".gitignore":       "dist/\n",
		".wayfinderignore": "!core/dist/src/app/experimental/is-overflowing.d.ts\n",
		"core/dist/src/app/experimental/is-overflowing.d.ts": "export declare const isOverflowing: boolean;\n",
		"core/src/app/experimental/is-overflowing.ts":        "export const isOverflowing = false;\n",
	})

	discovery, err := workspace.Discover(fixture.Root, workspace.DiscoverOptions{})
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}

	want := []workspace.Source{
		{Path: "core/src/app/experimental/is-overflowing.ts", ProjectID: "project:."},
	}
	if !reflect.DeepEqual(discovery.Sources, want) {
		t.Errorf("sources = %#v, want %#v", discovery.Sources, want)
	}
}

func TestDiscoverExcludesSourcesBelowBareGitIgnoreDirectoryPattern(t *testing.T) {
	fixture := testkit.NewWorkspace(t, map[string]string{
		"package.json":                 `{"name":"root"}`,
		".gitignore":                   "dist\n!**/packages/**\n",
		"dist/packages/generated.d.ts": "export declare const generated: boolean;\n",
		"src/main.ts":                  "export const main = true;\n",
	})

	discovery, err := workspace.Discover(fixture.Root, workspace.DiscoverOptions{})
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}

	want := []workspace.Source{{Path: "src/main.ts", ProjectID: "project:."}}
	if !reflect.DeepEqual(discovery.Sources, want) {
		t.Errorf("sources = %#v, want %#v", discovery.Sources, want)
	}
}

func TestDiscoverIncludesSourcesBelowGitIgnoreDirectoryRestoredByLaterRule(t *testing.T) {
	fixture := testkit.NewWorkspace(t, map[string]string{
		"package.json": `{"name":"root"}`,
		".gitignore":   "dist/\n!dist/\n",
		"dist/keep.ts": "export const keep = true;\n",
		"src/main.ts":  "export const main = true;\n",
	})

	discovery, err := workspace.Discover(fixture.Root, workspace.DiscoverOptions{})
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}

	want := []workspace.Source{
		{Path: "dist/keep.ts", ProjectID: "project:."},
		{Path: "src/main.ts", ProjectID: "project:."},
	}
	if !reflect.DeepEqual(discovery.Sources, want) {
		t.Errorf("sources = %#v, want %#v", discovery.Sources, want)
	}
}

func TestDiscoverReportsClientFlexSourceCountWhenConfigured(t *testing.T) {
	root := os.Getenv("AGENT_WAYFINDER_CLIENTFLEX_ROOT")
	if root == "" {
		t.Skip("set AGENT_WAYFINDER_CLIENTFLEX_ROOT to run the ClientFlex discovery test")
	}

	discovery, err := workspace.Discover(root, workspace.DiscoverOptions{})
	if err != nil {
		t.Fatalf("discover ClientFlex workspace: %v", err)
	}
	if len(discovery.Sources) == 0 {
		t.Fatal("discover ClientFlex workspace: no supported source files")
	}
	for _, source := range discovery.Sources {
		if source.Path == "core-sam/dist/packages/allocation/stage/config/action-config.d.ts" {
			t.Fatalf("discover ClientFlex workspace: ignored source %q was included", source.Path)
		}
	}
	t.Logf("ClientFlex supported source files after exclusions: %d", len(discovery.Sources))
}

func TestDiscoverExcludesSourcesIgnoredByNestedGitignore(t *testing.T) {
	fixture := testkit.NewWorkspace(t, map[string]string{
		"package.json":                                  `{"name":"root"}`,
		"packages/client/package.json":                  `{"name":"client"}`,
		"packages/client/.gitignore":                    "generated/\n",
		"packages/client/generated/client.generated.ts": "export const generated = true;\n",
		"packages/client/src/client.ts":                 "export const client = true;\n",
	})

	discovery, err := workspace.Discover(fixture.Root, workspace.DiscoverOptions{})
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}

	want := []workspace.Source{
		{Path: "packages/client/src/client.ts", ProjectID: "project:packages/client"},
	}
	if !reflect.DeepEqual(discovery.Sources, want) {
		t.Errorf("sources = %#v, want %#v", discovery.Sources, want)
	}
}

func TestDiscoverKeepsParentGitIgnoredDirectoryExcluded(t *testing.T) {
	fixture := testkit.NewWorkspace(t, map[string]string{
		"package.json":                  `{"name":"root"}`,
		".gitignore":                    "dist/\n",
		"packages/client/package.json":  `{"name":"client"}`,
		"packages/client/.gitignore":    "!dist/keep.js\n",
		"packages/client/dist/keep.js":  "export const keep = true;\n",
		"packages/client/src/client.ts": "export const client = true;\n",
	})

	discovery, err := workspace.Discover(fixture.Root, workspace.DiscoverOptions{})
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}

	want := []workspace.Source{
		{Path: "packages/client/src/client.ts", ProjectID: "project:packages/client"},
	}
	if !reflect.DeepEqual(discovery.Sources, want) {
		t.Errorf("sources = %#v, want %#v", discovery.Sources, want)
	}
}

func TestDiscoverNestedGitignoreRestoresFileIgnoredByAncestorPattern(t *testing.T) {
	fixture := testkit.NewWorkspace(t, map[string]string{
		"package.json":                   `{"name":"root"}`,
		".gitignore":                     "*.ts\n",
		"packages/client/package.json":   `{"name":"client"}`,
		"packages/client/.gitignore":     "!client.ts\n",
		"packages/client/src/client.ts":  "export const client = true;\n",
		"packages/client/src/ignored.ts": "export const ignored = true;\n",
	})

	discovery, err := workspace.Discover(fixture.Root, workspace.DiscoverOptions{})
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}

	want := []workspace.Source{
		{Path: "packages/client/src/client.ts", ProjectID: "project:packages/client"},
	}
	if !reflect.DeepEqual(discovery.Sources, want) {
		t.Errorf("sources = %#v, want %#v", discovery.Sources, want)
	}
}

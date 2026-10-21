package configuration

import (
	"reflect"
	"testing"

	"agent-wayfinder/testkit"
)

func TestReadSourceSelectionMergesLayeredArraysIndependently(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		workspace string
		want      SourceSelection
	}{
		{
			name: "user defaults",
			want: SourceSelection{Include: []string{"user/**/*.ts"}, Exclude: []string{"**/*.test.ts"}},
		},
		{
			name:      "workspace include",
			workspace: `{"sources":{"include":["workspace/**/*.ts"]}}`,
			want:      SourceSelection{Include: []string{"workspace/**/*.ts"}, Exclude: []string{"**/*.test.ts"}},
		},
		{
			name:      "workspace exclude",
			workspace: `{"sources":{"exclude":["**/generated/**"]}}`,
			want:      SourceSelection{Include: []string{"user/**/*.ts"}, Exclude: []string{"**/generated/**"}},
		},
		{
			name:      "workspace arrays",
			workspace: `{"sources":{"include":["workspace/**/*.ts"],"exclude":[]}}`,
			want:      SourceSelection{Include: []string{"workspace/**/*.ts"}, Exclude: []string{}},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			user := testkit.NewWorkspace(t, map[string]string{})
			user.WriteFile(t, ".agent-wayfinder/config.json", `{"sources":{"include":["user/**/*.ts"],"exclude":["**/*.test.ts"]}}`)
			t.Setenv("HOME", user.Root)
			t.Setenv("USERPROFILE", user.Root)
			files := map[string]string{}
			if testCase.workspace != "" {
				files[".agent-wayfinder/config.json"] = testCase.workspace
			}
			workspace := testkit.NewWorkspace(t, files)

			selection, err := ReadSourceSelection(workspace.Root)
			if err != nil {
				t.Fatalf("read source selection: %v", err)
			}
			if !reflect.DeepEqual(selection, testCase.want) {
				t.Errorf("source selection = %+v, want %+v", selection, testCase.want)
			}
		})
	}
}

func TestReadSourceSelectionRejectsInvalidPatterns(t *testing.T) {
	workspace := testkit.NewWorkspace(t, map[string]string{
		".agent-wayfinder/config.json": `{"sources":{"include":["["]}}`,
	})

	_, err := ReadSourceSelection(workspace.Root)
	if err == nil {
		t.Fatal("read source selection error = nil, want invalid pattern error")
	}
}

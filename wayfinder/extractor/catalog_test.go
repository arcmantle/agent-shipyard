package extractor_test

import (
	"reflect"
	"sort"
	"strings"
	"testing"

	"agent-wayfinder/extractor"
	goextractor "agent-wayfinder/extractors/go"
	"agent-wayfinder/extractors/javascript"
	"agent-wayfinder/extractors/typescript"
)

func TestExtractorsProvideEligibleCatalogUnits(t *testing.T) {
	testCases := []struct {
		name     string
		extract  func(extractor.Source) (extractor.Contribution, error)
		path     string
		contents string
		want     []string
	}{
		{
			name:     "Go",
			extract:  goextractor.Extract,
			path:     "src/catalog.go",
			contents: "package fixture\n\ntype Validator struct{}\nfunc ValidateToken() {}\nfunc (Validator) Check() {}\nfunc local() { value := 1; _ = value }\n",
			want:     []string{"Check", "ValidateToken", "Validator", "local"},
		},
		{
			name:     "JavaScript",
			extract:  javascript.Extract,
			path:     "src/catalog.js",
			contents: "class Validator { check() {} }\nfunction validateToken() {}\nfunction local() { const value = 1; return value; }\n",
			want:     []string{"Validator", "check", "local", "validateToken"},
		},
		{
			name:     "TypeScript",
			extract:  typescript.Extract,
			path:     "src/catalog.ts",
			contents: "interface Validator { check(): void }\ntype Alias = string;\nclass TokenValidator { validateToken(): void {} }\nfunction local() { const value = 1; return value; }\n",
			want:     []string{"TokenValidator", "Validator", "check", "local", "validateToken"},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			contribution, err := testCase.extract(extractor.Source{
				ProjectID:  "project:fixture",
				SourcePath: testCase.path,
				Contents:   []byte(testCase.contents),
			})
			if err != nil {
				t.Fatalf("extract source: %v", err)
			}
			units := contribution.CatalogUnits()
			got := make([]string, len(units))
			for index, unit := range units {
				got[index] = unit.Name
			}
			sort.Strings(got)
			if !reflect.DeepEqual(got, testCase.want) {
				t.Errorf("catalog units = %#v, want %#v", got, testCase.want)
			}
			for _, unit := range units {
				if unit.Name == "check" && unit.Owner != "Validator" {
					t.Errorf("catalog method owner = %q, want Validator", unit.Owner)
				}
			}
		})
	}
}

func TestCatalogUnitIncludesMethodDeclarationSource(t *testing.T) {
	contents := "package fixture\n\ntype Validator struct{}\n\nfunc (Validator) ValidateToken(token string) error {\n\treturn nil\n}\n"
	contribution, err := goextractor.Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/catalog.go",
		Contents:   []byte(contents),
	})
	if err != nil {
		t.Fatalf("extract source: %v", err)
	}

	units := contribution.CatalogUnits()
	if len(units) != 2 {
		t.Fatalf("catalog unit count = %d, want 2", len(units))
	}
	if got, want := units[1].DeclarationSource, "func (Validator) ValidateToken(token string) error {\n\treturn nil\n}"; got != want {
		t.Errorf("catalog declaration source = %q, want %q", got, want)
	}
}

func TestCatalogUnitsIncludeDeclarationSourceAcrossLanguages(t *testing.T) {
	testCases := []struct {
		name     string
		extract  func(extractor.Source) (extractor.Contribution, error)
		path     string
		contents string
		want     string
	}{
		{
			name:     "JavaScript",
			extract:  javascript.Extract,
			path:     "src/catalog.js",
			contents: "function validateToken(token) {\n  return token.length > 0;\n}\n",
			want:     "function validateToken(token) {\n  return token.length > 0;\n}",
		},
		{
			name:     "TypeScript",
			extract:  typescript.Extract,
			path:     "src/catalog.ts",
			contents: "function validateToken(token: string): boolean {\n  return token.length > 0;\n}\n",
			want:     "function validateToken(token: string): boolean {\n  return token.length > 0;\n}",
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			contribution, err := testCase.extract(extractor.Source{
				ProjectID:  "project:fixture",
				SourcePath: testCase.path,
				Contents:   []byte(testCase.contents),
			})
			if err != nil {
				t.Fatalf("extract source: %v", err)
			}

			units := contribution.CatalogUnits()
			if len(units) != 1 {
				t.Fatalf("catalog unit count = %d, want 1", len(units))
			}
			if got := units[0].DeclarationSource; got != testCase.want {
				t.Errorf("catalog declaration source = %q, want %q", got, testCase.want)
			}
		})
	}
}

func TestCatalogUnitLimitsDeclarationSourceSize(t *testing.T) {
	contents := "package fixture\n\ntype Validator struct{}\n\nfunc (Validator) ValidateToken() {\n\t" + strings.Repeat("value += 1\n\t", 400) + "}\n"
	contribution, err := goextractor.Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/catalog.go",
		Contents:   []byte(contents),
	})
	if err != nil {
		t.Fatalf("extract source: %v", err)
	}

	units := contribution.CatalogUnits()
	if len(units) != 2 {
		t.Fatalf("catalog unit count = %d, want 2", len(units))
	}
	if got := len([]byte(units[1].DeclarationSource)); got != 4*1024 {
		t.Errorf("catalog declaration source size = %d, want %d", got, 4*1024)
	}
}

func TestCatalogUnitBuildsDeterministicSynopsisFromSourceData(t *testing.T) {
	unit := extractor.CatalogUnit{
		Name:             "ValidateToken",
		Kind:             "go:method",
		Owner:            "Validator",
		Signature:        "func (Validator) ValidateToken(token string) error",
		Comments:         []string{"ValidateToken checks a signed access token."},
		IdentifierTokens: []string{"validate", "token"},
	}

	if got, want := unit.DeterministicSynopsis(), "Validator.ValidateToken (go:method). ValidateToken checks a signed access token. Signature: func (Validator) ValidateToken(token string) error. Identifiers: validate token"; got != want {
		t.Errorf("deterministic synopsis = %q, want %q", got, want)
	}
}

func TestCatalogUnitLimitsDeterministicSynopsisLength(t *testing.T) {
	unit := extractor.CatalogUnit{
		Name:             "ValidateToken",
		Kind:             "go:function",
		Signature:        "func ValidateToken(token string) error",
		Comments:         []string{strings.Repeat("checks a signed access token ", 20)},
		IdentifierTokens: []string{"validate", "token"},
	}

	if got := len([]rune(unit.DeterministicSynopsis())); got != 300 {
		t.Errorf("deterministic synopsis length = %d, want 300", got)
	}
}

func TestCatalogUnitsReadLeadingBlockComments(t *testing.T) {
	contribution, err := javascript.Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/validator.js",
		Contents:   []byte("/* ValidateToken checks a signed access token. */\nfunction ValidateToken(token) {}\n"),
	})
	if err != nil {
		t.Fatalf("extract JavaScript source: %v", err)
	}

	units := contribution.CatalogUnits()
	if len(units) != 1 {
		t.Fatalf("catalog unit count = %d, want 1", len(units))
	}
	if got, want := units[0].Comments, []string{"ValidateToken checks a signed access token."}; !reflect.DeepEqual(got, want) {
		t.Errorf("catalog comments = %#v, want %#v", got, want)
	}
}

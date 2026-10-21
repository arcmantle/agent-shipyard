package benchmark

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type CorpusSpec struct {
	SourceFiles           int
	FunctionsPerFile      int
	AdditionalFunctions   int
	UncalledFunctions     int
	ExtraSideEffectImport bool
}

var DefaultCorpusSpec = CorpusSpec{
	SourceFiles:           10000,
	FunctionsPerFile:      98,
	AdditionalFunctions:   9999,
	UncalledFunctions:     9996,
	ExtraSideEffectImport: true,
}

func ExactScaleCorpusSpec(sourceFiles int) (CorpusSpec, error) {
	if sourceFiles < 4 {
		return CorpusSpec{}, fmt.Errorf("exact scale corpus requires at least 4 source files")
	}
	return CorpusSpec{
		SourceFiles:           sourceFiles,
		FunctionsPerFile:      98,
		AdditionalFunctions:   sourceFiles - 1,
		UncalledFunctions:     sourceFiles - 4,
		ExtraSideEffectImport: true,
	}, nil
}

type Corpus struct {
	SourceFiles      int
	FunctionsPerFile int
	FunctionCount    int
	ExpectedNodes    int
	ExpectedEdges    int
	UpdatePath       string
	QueryTerm        string
	PathSource       string
	PathTarget       string
	ExplainTerm      string
}

func GenerateCorpus(root string, specification CorpusSpec) (Corpus, error) {
	return GenerateCorpusWithProgress(root, specification, nil)
}

func GenerateCorpusWithProgress(root string, specification CorpusSpec, progress func(created, total int)) (Corpus, error) {
	if root == "" || specification.SourceFiles <= 0 || specification.FunctionsPerFile <= 0 || specification.AdditionalFunctions < 0 || specification.UncalledFunctions < 0 || specification.UncalledFunctions > specification.FunctionsPerFile+specification.AdditionalFunctions-1 {
		return Corpus{}, fmt.Errorf("generate benchmark corpus: root, positive source file count, positive function count, and valid additional function settings are required")
	}

	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte(`{"name":"agent-wayfinder-benchmark","type":"module"}`), 0o644); err != nil {
		return Corpus{}, fmt.Errorf("generate benchmark corpus: write package manifest: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		return Corpus{}, fmt.Errorf("generate benchmark corpus: create source directory: %w", err)
	}

	width := len(strconv.Itoa(specification.SourceFiles - 1))
	for sourceIndex := 0; sourceIndex < specification.SourceFiles; sourceIndex++ {
		path := modulePath(sourceIndex, width)
		contents := moduleContents(sourceIndex, specification, width)
		if err := os.WriteFile(filepath.Join(root, path), []byte(contents), 0o644); err != nil {
			return Corpus{}, fmt.Errorf("generate benchmark corpus: write source %q: %w", path, err)
		}
		if progress != nil {
			progress(sourceIndex+1, specification.SourceFiles)
		}
	}

	firstModule := moduleName(0, width)
	secondModule := moduleName(min(1, specification.SourceFiles-1), width)
	entry := functionName(0, 0, width)
	target := functionName(min(1, specification.SourceFiles-1), 0, width)
	functionCount := specification.SourceFiles*specification.FunctionsPerFile + specification.AdditionalFunctions
	expectedEdges := 2*functionCount - specification.UncalledFunctions + 3*specification.SourceFiles - 3
	if specification.ExtraSideEffectImport && specification.SourceFiles >= 3 {
		expectedEdges++
	}
	return Corpus{
		SourceFiles:      specification.SourceFiles,
		FunctionsPerFile: specification.FunctionsPerFile,
		FunctionCount:    functionCount,
		ExpectedNodes:    functionCount + specification.SourceFiles + 1,
		ExpectedEdges:    expectedEdges,
		UpdatePath:       modulePath(0, width),
		QueryTerm:        entry,
		PathSource:       "src/" + firstModule + ".ts::" + entry,
		PathTarget:       "src/" + secondModule + ".ts::" + target,
		ExplainTerm:      entry,
	}, nil
}

func moduleContents(sourceIndex int, specification CorpusSpec, width int) string {
	var contents strings.Builder
	if sourceIndex+1 < specification.SourceFiles {
		nextFunction := functionName(sourceIndex+1, 0, width)
		fmt.Fprintf(&contents, "import { %s } from './%s';\n", nextFunction, moduleName(sourceIndex+1, width))
	}
	if sourceIndex == 0 && specification.ExtraSideEffectImport && specification.SourceFiles >= 3 {
		fmt.Fprintf(&contents, "import './%s';\n", moduleName(2, width))
	}
	functionCount := specification.FunctionsPerFile + distributedCount(specification.AdditionalFunctions, specification.SourceFiles, sourceIndex)
	uncalledFunctions := distributedCount(specification.UncalledFunctions, specification.SourceFiles, sourceIndex)
	for functionIndex := 0; functionIndex < functionCount; functionIndex++ {
		name := functionName(sourceIndex, functionIndex, width)
		call := "0"
		if functionIndex >= functionCount-uncalledFunctions {
			call = "0"
		} else if functionIndex > 0 {
			call = functionName(sourceIndex, functionIndex-1, width) + "()"
		} else if sourceIndex+1 < specification.SourceFiles {
			call = functionName(sourceIndex+1, 0, width) + "()"
		}
		fmt.Fprintf(&contents, "export function %s(): number { return %s; }\n", name, call)
	}
	return contents.String()
}

func distributedCount(total, buckets, bucket int) int {
	count := total / buckets
	if bucket < total%buckets {
		count++
	}
	return count
}

// RealisticCorpusSpec generates a corpus shaped after measured workspace density
// (imports, exports, and declaration mix per file) instead of CorpusSpec's dense,
// single-kind, linear import chain. Node and edge counts are data-derived, so
// Corpus.ExpectedNodes and Corpus.ExpectedEdges are left unset (0) and skipped
// during benchmark validation.
type RealisticCorpusSpec struct {
	SourceFiles int
}

// realisticImportFanIn bounds how many earlier files each generated file imports
// from, matching the small, bounded import counts seen in real workspaces rather
// than a single unbounded chain.
const realisticImportFanIn = 4

func NewRealisticCorpusSpec(sourceFiles int) (RealisticCorpusSpec, error) {
	if sourceFiles < 1 {
		return RealisticCorpusSpec{}, fmt.Errorf("realistic corpus requires at least 1 source file")
	}
	return RealisticCorpusSpec{SourceFiles: sourceFiles}, nil
}

func GenerateRealisticCorpus(root string, specification RealisticCorpusSpec) (Corpus, error) {
	return GenerateRealisticCorpusWithProgress(root, specification, nil)
}

func GenerateRealisticCorpusWithProgress(root string, specification RealisticCorpusSpec, progress func(created, total int)) (Corpus, error) {
	if root == "" || specification.SourceFiles < 1 {
		return Corpus{}, fmt.Errorf("generate realistic benchmark corpus: root and a positive source file count are required")
	}

	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte(`{"name":"agent-wayfinder-benchmark","type":"module"}`), 0o644); err != nil {
		return Corpus{}, fmt.Errorf("generate realistic benchmark corpus: write package manifest: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		return Corpus{}, fmt.Errorf("generate realistic benchmark corpus: create source directory: %w", err)
	}

	width := len(strconv.Itoa(specification.SourceFiles - 1))
	for sourceIndex := 0; sourceIndex < specification.SourceFiles; sourceIndex++ {
		path := modulePath(sourceIndex, width)
		contents := realisticModuleContents(sourceIndex, width)
		if err := os.WriteFile(filepath.Join(root, path), []byte(contents), 0o644); err != nil {
			return Corpus{}, fmt.Errorf("generate realistic benchmark corpus: write source %q: %w", path, err)
		}
		if progress != nil {
			progress(sourceIndex+1, specification.SourceFiles)
		}
	}

	target := min(1, specification.SourceFiles-1)
	entry := functionName(0, 0, width)
	targetEntry := functionName(target, 0, width)
	return Corpus{
		SourceFiles: specification.SourceFiles,
		UpdatePath:  modulePath(0, width),
		QueryTerm:   entry,
		PathSource:  "src/" + moduleName(0, width) + ".ts::" + entry,
		PathTarget:  "src/" + moduleName(target, width) + ".ts::" + targetEntry,
		ExplainTerm: entry,
	}, nil
}

// realisticModuleContents writes one module with a bounded set of imports and a
// mix of declaration kinds (function always, class/interface/type alias on a
// period), matching the low per-file density and richer declaration mix of real
// workspaces instead of hundreds of single-line trivial functions.
func realisticModuleContents(sourceIndex, width int) string {
	var contents strings.Builder
	importSources := realisticImportSources(sourceIndex)
	for _, importIndex := range importSources {
		fmt.Fprintf(&contents, "import { %s } from './%s';\n", functionName(importIndex, 0, width), moduleName(importIndex, width))
	}
	if len(importSources) > 0 {
		contents.WriteString("\n")
	}

	name := functionName(sourceIndex, 0, width)
	contents.WriteString("// Computes a derived value for this module.\n")
	fmt.Fprintf(&contents, "export function %s(): number {\n", name)
	contents.WriteString("\tconst base = 1;\n")
	if len(importSources) > 0 {
		fmt.Fprintf(&contents, "\treturn base + %s();\n", functionName(importSources[0], 0, width))
	} else {
		contents.WriteString("\treturn base;\n")
	}
	contents.WriteString("}\n")

	if sourceIndex%3 == 0 {
		className := realisticDeclarationName("Cls", sourceIndex, width)
		contents.WriteString("\n// Wraps the module function behind a small service class.\n")
		fmt.Fprintf(&contents, "export class %s {\n", className)
		contents.WriteString("\trun(): number {\n")
		fmt.Fprintf(&contents, "\t\treturn %s();\n", name)
		contents.WriteString("\t}\n")
		contents.WriteString("}\n")
	}
	if sourceIndex%5 == 0 {
		interfaceName := realisticDeclarationName("Iface", sourceIndex, width)
		contents.WriteString("\n// Describes the shape returned by this module.\n")
		fmt.Fprintf(&contents, "export interface %s {\n", interfaceName)
		contents.WriteString("\tvalue: number;\n")
		contents.WriteString("}\n")
	}
	if sourceIndex%7 == 0 {
		typeName := realisticDeclarationName("Type", sourceIndex, width)
		contents.WriteString("\n// Aliases the module's return shape.\n")
		fmt.Fprintf(&contents, "export type %s = { value: number };\n", typeName)
	}
	if sourceIndex%11 == 0 {
		envName := realisticDeclarationName("env", sourceIndex, width)
		contents.WriteString("\n// Reads a build-time environment value, as real bundler-targeted modules do.\n")
		fmt.Fprintf(&contents, "export const %s = (import.meta.env.BASE_URL || '').replace(/\\/+$/, '');\n", envName)
	}
	return contents.String()
}

// realisticImportSources returns up to realisticImportFanIn preceding file
// indices, giving each file a small, bounded import fan-in instead of an
// unbounded chain.
func realisticImportSources(sourceIndex int) []int {
	sources := make([]int, 0, realisticImportFanIn)
	for offset := 1; offset <= realisticImportFanIn; offset++ {
		candidate := sourceIndex - offset
		if candidate < 0 {
			break
		}
		sources = append(sources, candidate)
	}
	return sources
}

func realisticDeclarationName(prefix string, sourceIndex, width int) string {
	return prefix + fmt.Sprintf("%0*d", width, sourceIndex)
}

func modulePath(sourceIndex, width int) string {
	return filepath.Join("src", moduleName(sourceIndex, width)+".ts")
}

func moduleName(sourceIndex, width int) string {
	return "module-" + fmt.Sprintf("%0*d", width, sourceIndex)
}

func functionName(sourceIndex, functionIndex, width int) string {
	return fmt.Sprintf("function_%0*d_%03d", width, sourceIndex, functionIndex)
}

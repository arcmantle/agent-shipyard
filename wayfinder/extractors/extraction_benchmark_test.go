package extractors_test

import (
	"testing"

	"agent-wayfinder/extractor"
	goextractor "agent-wayfinder/extractors/go"
	"agent-wayfinder/extractors/javascript"
	"agent-wayfinder/extractors/typescript"
)

func BenchmarkWorkerExtractionParity(b *testing.B) {
	benchmarkWorkerExtraction(b, "Go", goextractor.NewWorker, extractor.Source{
		ProjectID:  "project:benchmark",
		SourcePath: "src/service.go",
		Contents: []byte(`package benchmark

type Runner interface { Run() int }
type Label = string

const DefaultLabel Label = "default"

var callback = func(value int) int { return value + 1 }

type Record struct { Value int }

func (Record) Run() int { return 1 }

func Execute() int {
	record := Record{}
	return callback(record.Run())
}
`),
	})

	benchmarkWorkerExtraction(b, "JavaScript", javascript.NewWorker, extractor.Source{
		ProjectID:  "project:benchmark",
		SourcePath: "src/service.js",
		Contents: []byte(`export const callback = (value) => value + 1;

export class Record {
	run() { return 1; }
}

export function execute() {
	const record = new Record();
	return callback(record.run());
}
`),
	})

	benchmarkWorkerExtraction(b, "TypeScript", typescript.NewWorker, extractor.Source{
		ProjectID:  "project:benchmark",
		SourcePath: "src/service.ts",
		Contents: []byte(`export interface Runner { run(): number; }
export type Label = string;

export const defaultLabel: Label = "default";

export const callback = (value: number): number => value + 1;

export class Record implements Runner {
	value = 1;
	run(): number { return this.value; }
}

export function execute(): number {
	const record = new Record();
	return callback(record.run());
}
`),
	})
}

type extractionWorker interface {
	Extract(extractor.Source) (extractor.Contribution, error)
	Close() error
}

func benchmarkWorkerExtraction[T extractionWorker](b *testing.B, name string, newWorker func() (T, error), source extractor.Source) {
	b.Helper()
	b.Run(name, func(b *testing.B) {
		worker, err := newWorker()
		if err != nil {
			b.Fatalf("create worker: %v", err)
		}
		b.Cleanup(func() {
			if err := worker.Close(); err != nil {
				b.Errorf("close worker: %v", err)
			}
		})

		b.SetBytes(int64(len(source.Contents)))
		b.ReportAllocs()
		b.ResetTimer()
		for iteration := 0; iteration < b.N; iteration++ {
			if _, err := worker.Extract(source); err != nil {
				b.Fatalf("extract source: %v", err)
			}
		}
	})
}

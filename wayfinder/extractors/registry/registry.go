package registry

import (
	"fmt"

	"agent-wayfinder/extractor"
	goextractor "agent-wayfinder/extractors/go"
	"agent-wayfinder/extractors/javascript"
	"agent-wayfinder/extractors/typescript"
)

type Registry struct {
	byExtension map[string]extractor.Extractor
	extractors  []extractor.Extractor
}

func Default() (Registry, error) {
	return New(goextractor.New(), javascript.New(), typescript.New())
}

func New(extractors ...extractor.Extractor) (Registry, error) {
	registry := Registry{
		byExtension: make(map[string]extractor.Extractor),
		extractors:  make([]extractor.Extractor, 0, len(extractors)),
	}

	for _, registered := range extractors {
		if registered == nil {
			return Registry{}, fmt.Errorf("extractor is nil")
		}

		metadata := registered.Metadata()
		if err := metadata.Validate(); err != nil {
			return Registry{}, err
		}
		if _, err := registered.Vocabulary(); err != nil {
			return Registry{}, fmt.Errorf("extractor %q vocabulary: %w", metadata.Name, err)
		}

		for _, extension := range metadata.Extensions {
			normalized := extractor.NormalizeExtension(extension)
			if current, exists := registry.byExtension[normalized]; exists {
				return Registry{}, fmt.Errorf(
					"extension %q is registered by both %q and %q",
					normalized,
					current.Metadata().Name,
					metadata.Name,
				)
			}
			registry.byExtension[normalized] = registered
		}

		registry.extractors = append(registry.extractors, registered)
	}

	return registry, nil
}

func (registry Registry) ForPath(path string) (extractor.Extractor, bool) {
	registered, ok := registry.byExtension[extractor.Extension(path)]
	return registered, ok
}

func (registry Registry) All() []extractor.Extractor {
	registered := make([]extractor.Extractor, len(registry.extractors))
	copy(registered, registry.extractors)
	return registered
}

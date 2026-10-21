package catalog

type catalogProcessUsage struct {
	CPUPercent          float64 `json:"cpuPercent"`
	ResidentMemoryBytes uint64  `json:"residentMemoryBytes"`
}

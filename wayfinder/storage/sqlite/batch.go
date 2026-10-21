package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

func insertRows(ctx context.Context, transaction *sql.Tx, variableLimit, maximumRows int, prefix string, rows [][]any) error {
	if len(rows) == 0 {
		return nil
	}
	columnCount := len(rows[0])
	if columnCount == 0 {
		return fmt.Errorf("insert rows: row has no values")
	}
	rowsPerBatch := variableLimit / columnCount
	if rowsPerBatch > maximumRows {
		rowsPerBatch = maximumRows
	}
	if rowsPerBatch < 1 {
		return fmt.Errorf("insert rows: SQLite variable limit %d is below row width %d", variableLimit, columnCount)
	}

	placeholder := "(" + strings.TrimSuffix(strings.Repeat("?,", columnCount), ",") + ")"
	for start := 0; start < len(rows); start += rowsPerBatch {
		end := min(start+rowsPerBatch, len(rows))
		arguments := make([]any, 0, (end-start)*columnCount)
		for _, row := range rows[start:end] {
			if len(row) != columnCount {
				return fmt.Errorf("insert rows: row width %d does not match %d", len(row), columnCount)
			}
			arguments = append(arguments, row...)
		}
		query := prefix + strings.TrimSuffix(strings.Repeat(placeholder+",", end-start), ",")
		if _, err := transaction.ExecContext(ctx, query, arguments...); err != nil {
			return err
		}
	}
	return nil
}

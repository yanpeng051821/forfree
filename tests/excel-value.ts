import type ExcelJS from 'exceljs';

// Formula caches remain numeric (including zero); unknown inputs remain blank.
export function effective(cell: ExcelJS.Cell) {
  return cell.formula ? cell.result === '' || cell.result === undefined ? null : cell.result : cell.value;
}

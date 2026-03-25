
import * as XLSX from 'xlsx';

export const parseExcelFile = async (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        if (!data) return resolve("");

        const workbook = XLSX.read(data, { type: 'binary' });
        let contextString = "KEYWORD DATABASE / EXCEL REFERENCE:\n";

        workbook.SheetNames.forEach((sheetName) => {
          const sheet = workbook.Sheets[sheetName];
          // Convert sheet to CSV for compact text representation
          const csv = XLSX.utils.sheet_to_csv(sheet);
          if (csv && csv.trim().length > 0) {
            contextString += `\n[Sheet: ${sheetName}]\n${csv}\n`;
          }
        });

        resolve(contextString);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = (error) => reject(error);
    reader.readAsBinaryString(file);
  });
};

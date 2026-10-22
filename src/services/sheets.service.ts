import { google } from 'googleapis';
import { googleAuth } from './google-auth.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { SheetData } from '../types.js';

const sheets = googleAuth ? google.sheets({ version: 'v4', auth: googleAuth }) : null;
const drive = googleAuth ? google.drive({ version: 'v3', auth: googleAuth }) : null;

const SAGE = { red: 0.518, green: 0.663, blue: 0.549 }; // #84a98c
const SAGE_LIGHT = { red: 0.878, green: 0.918, blue: 0.886 }; // light sage for alt rows
const WHITE = { red: 1, green: 1, blue: 1 };
const DARK = { red: 0.15, green: 0.15, blue: 0.15 };

export const sheetsService = {
  isConfigured(): boolean {
    return !!sheets && !!drive;
  },

  async createSpreadsheet(data: SheetData): Promise<string | null> {
    if (!sheets || !drive) return null;

    try {
      const numRows = data.rows.length;
      const numCols = data.headers.length;

      // Build all row data: header + data rows + optional total row
      const allRows: any[] = [];

      // Header row
      allRows.push({
        values: data.headers.map((h) => ({
          userEnteredValue: { stringValue: h },
          userEnteredFormat: {
            backgroundColor: SAGE,
            textFormat: { bold: true, fontSize: 11, foregroundColor: WHITE },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
            padding: { top: 8, bottom: 8, left: 12, right: 12 },
          },
        })),
      });

      // Data rows with alternating colors
      for (let i = 0; i < numRows; i++) {
        const row = data.rows[i];
        const bgColor = i % 2 === 0 ? WHITE : SAGE_LIGHT;

        allRows.push({
          values: row.map((cell, colIdx) => {
            const isCurrency = data.currencyColumns.includes(colIdx);
            const format: any = {
              backgroundColor: bgColor,
              textFormat: { fontSize: 10, foregroundColor: DARK },
              verticalAlignment: 'MIDDLE',
              padding: { top: 6, bottom: 6, left: 12, right: 12 },
            };

            if (isCurrency) {
              format.numberFormat = { type: 'CURRENCY', pattern: '£#,##0.00' };
              format.horizontalAlignment = 'RIGHT';
            }

            const value: any = {};
            if (typeof cell === 'number') {
              value.numberValue = cell;
            } else {
              value.stringValue = String(cell);
            }

            return { userEnteredValue: value, userEnteredFormat: format };
          }),
        });
      }

      // Total row
      if (data.includeTotal && data.currencyColumns.length > 0) {
        const totalValues = data.headers.map((_, colIdx) => {
          if (colIdx === 0) {
            return {
              userEnteredValue: { stringValue: 'Total' },
              userEnteredFormat: {
                backgroundColor: SAGE,
                textFormat: { bold: true, fontSize: 11, foregroundColor: WHITE },
                horizontalAlignment: 'LEFT',
                padding: { top: 8, bottom: 8, left: 12, right: 12 },
              },
            };
          }

          if (data.currencyColumns.includes(colIdx)) {
            // Sum formula — column letter from index
            const colLetter = String.fromCharCode(65 + colIdx);
            const formula = `=SUM(${colLetter}2:${colLetter}${numRows + 1})`;
            return {
              userEnteredValue: { formulaValue: formula },
              userEnteredFormat: {
                backgroundColor: SAGE,
                textFormat: { bold: true, fontSize: 11, foregroundColor: WHITE },
                numberFormat: { type: 'CURRENCY', pattern: '£#,##0.00' },
                horizontalAlignment: 'RIGHT',
                padding: { top: 8, bottom: 8, left: 12, right: 12 },
              },
            };
          }

          return {
            userEnteredValue: { stringValue: '' },
            userEnteredFormat: { backgroundColor: SAGE },
          };
        });

        allRows.push({ values: totalValues });
      }

      const totalRowCount = allRows.length;

      // Create spreadsheet
      const res = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: data.title },
          sheets: [
            {
              properties: {
                title: 'Sheet1',
                gridProperties: {
                  rowCount: totalRowCount + 5,
                  columnCount: numCols + 2,
                  frozenRowCount: 1,
                },
              },
              data: [{ startRow: 0, startColumn: 0, rowData: allRows }],
            },
          ],
        },
      });

      const spreadsheetId = res.data.spreadsheetId!;
      const sheetId = res.data.sheets![0].properties!.sheetId!;

      // Auto-resize columns and add borders
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              autoResizeDimensions: {
                dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: numCols },
              },
            },
            {
              updateBorders: {
                range: { sheetId, startRowIndex: 0, endRowIndex: totalRowCount, startColumnIndex: 0, endColumnIndex: numCols },
                top: { style: 'SOLID', color: SAGE },
                bottom: { style: 'SOLID', color: SAGE },
                left: { style: 'SOLID', color: SAGE },
                right: { style: 'SOLID', color: SAGE },
                innerHorizontal: { style: 'SOLID', color: { red: 0.85, green: 0.85, blue: 0.85 } },
                innerVertical: { style: 'SOLID', color: { red: 0.85, green: 0.85, blue: 0.85 } },
              },
            },
          ],
        },
      });

      // Make it viewable by anyone with the link
      await drive.permissions.create({
        fileId: spreadsheetId,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      // The sheet is owned by the service account, so without this nobody on the
      // team could edit it (or find it in their Drive). Grant the ForgeRealm
      // account editor access; failure here shouldn't fail the whole creation.
      if (config.GOOGLE_CALENDAR_ID.includes('@')) {
        try {
          await drive.permissions.create({
            fileId: spreadsheetId,
            sendNotificationEmail: false,
            requestBody: { role: 'writer', type: 'user', emailAddress: config.GOOGLE_CALENDAR_ID },
          });
        } catch (err) {
          logger.warn({ err }, 'Could not grant editor access on new spreadsheet');
        }
      }

      const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
      logger.info({ title: data.title, url }, 'Spreadsheet created');
      return url;
    } catch (err) {
      logger.error({ err }, 'Failed to create spreadsheet');
      return null;
    }
  },
};

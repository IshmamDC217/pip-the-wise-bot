import { google } from 'googleapis';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

import { parseServiceAccountJson } from '../utils/google-sa.js';

function createAuth() {
  if (!config.GOOGLE_SERVICE_ACCOUNT) return null;

  try {
    const credentials = parseServiceAccountJson(config.GOOGLE_SERVICE_ACCOUNT);

    return new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
      ],
    });
  } catch (err) {
    logger.error({ err }, 'Failed to parse Google credentials — calendar & sheets disabled');
    return null;
  }
}

export const googleAuth = createAuth();

export const GRID_SIZE = 25;
export const BLANK_COLOR = '#FFFFFF';

export class ValidationError extends Error {
  constructor(message, code = 'INVALID_SUBMISSION', status = 422) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.status = status;
  }
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ValidationError(`${label} must be text.`);
  const text = value.trim();
  if ([...text].length > maxLength) {
    throw new ValidationError(`${label} must be ${maxLength} characters or fewer.`);
  }
  if (/[\u0000-\u001F\u007F]/u.test(text)) {
    throw new ValidationError(`${label} cannot contain control characters.`);
  }
  return text;
}

export function validateSubmission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Please send a valid artwork.');
  }
  if (!Array.isArray(input.grid) || input.grid.length !== GRID_SIZE) {
    throw new ValidationError('Artwork must contain exactly 25 rows of 25 pixels.');
  }
  let paintedPixels = 0;
  const grid = input.grid.map((row) => {
    if (!Array.isArray(row) || row.length !== GRID_SIZE) {
      throw new ValidationError('Artwork must contain exactly 25 rows of 25 pixels.');
    }
    return row.map((color) => {
      if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
        throw new ValidationError('Each pixel must use a six-digit hex color.');
      }
      const normalized = color.toUpperCase();
      if (normalized !== BLANK_COLOR) paintedPixels += 1;
      return normalized;
    });
  });
  if (paintedPixels === 0) {
    throw new ValidationError('Add a little color before submitting your artwork.', 'EMPTY_ARTWORK');
  }
  if (typeof input.clientSubmissionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.clientSubmissionId)) {
    throw new ValidationError('A valid submission reference is required.', 'INVALID_REFERENCE');
  }
  return {
    grid,
    name: optionalText(input.name, 'Name', 60),
    studentId: optionalText(input.studentId, 'Student ID', 80),
    clientSubmissionId: input.clientSubmissionId.toLowerCase(),
  };
}

export function validatePagination(searchParams) {
  function integer(name, fallback, max) {
    const value = searchParams.get(name);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value)) throw new ValidationError(`Invalid ${name}.`, 'INVALID_PAGINATION', 400);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < (name === 'limit' ? 1 : 0) || number > max) {
      throw new ValidationError(`Invalid ${name}.`, 'INVALID_PAGINATION', 400);
    }
    return number;
  }
  return { limit: integer('limit', 24, 100), offset: integer('offset', 0, Number.MAX_SAFE_INTEGER) };
}

// Chrome contenteditable may represent visible spaces as non-breaking spaces.
export const normalizeDraft = (text: string) => text.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
export const maxInputLines = 1_200;

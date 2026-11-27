// Where the two scripts a rewritten Bash command runs sit: the reader, which prints the variables, and the masker,
// which every byte of the command's output passes through. Both live beside this file.
import path from 'node:path';

/** The script that reads the variables from the channel's socket with a one-time token. */
export const READER_SCRIPT = path.join(import.meta.dirname, 'secret-env.ts');

/** The script that masks each granted value in the command's output as it streams. */
export const MASKER = path.join(import.meta.dirname, 'secret-mask.ts');

// Hands one dropped file from the homepage to /demo inside the same site session. Held in memory only.
let pending: File | null = null;

export function setPendingFile(file: File): void {
  pending = file;
}

export function takePendingFile(): File | null {
  const file = pending;
  pending = null;
  return file;
}

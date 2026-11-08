/** Change a significant bit in the signature, regardless of base64url padding bits. */
export function forgeToken(token: string): string {
  const start = token.lastIndexOf(".") + 1;
  if (start <= 0 || start >= token.length) throw new Error("Invalid token fixture");
  return token.slice(0, start) + (token[start] === "A" ? "B" : "A") + token.slice(start + 1);
}

export function strictPdfOptions(data:Uint8Array) {
  return {data,isEvalSupported:false,stopAtErrors:true} as const;
}

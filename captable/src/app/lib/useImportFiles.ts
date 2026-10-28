import { useState } from "react";
import type { api } from "#shared";
import { addFiles, type ImportSource } from "./imports.ts";

type Kind = api.ImportDetectedFile["kind"];

// The files the import wizard holds, in the page's memory only: the chosen files, the ones just left out (with why),
// and what the last preview recognized each chosen file as. A file that is replaced or removed takes its recognition
// with it, and `clear` lets go of everything once the import is done, so no upload outlives its use.

export interface ImportFiles {
  files: File[];
  refused: string[];
  /** What the last preview recognized each file as, keyed by the very File it was made from. */
  detected: ReadonlyMap<File, Kind>;
  /** Adds chosen or dropped files (a same-named file is replaced in place); what can't be sent is listed in `refused`. */
  add: (source: ImportSource, chosen: readonly File[]) => void;
  remove: (file: File) => void;
  /** Records what a preview recognized the files it was made from as. */
  remember: (sent: readonly File[], detected: readonly api.ImportDetectedFile[]) => void;
  clearRefused: () => void;
  clear: () => void;
}

export function useImportFiles(): ImportFiles {
  const [files, setFiles] = useState<File[]>([]);
  const [refused, setRefused] = useState<string[]>([]);
  const [detected, setDetected] = useState<ReadonlyMap<File, Kind>>(new Map());
  const choose = (next: File[]) => {
    setFiles(next);
    setDetected((current) => new Map([...current].filter(([file]) => next.includes(file))));
  };
  return {
    files,
    refused,
    detected,
    add: (source, chosen) => {
      const next = addFiles(source, files, chosen);
      choose(next.files);
      setRefused(next.refused);
    },
    remove: (file) => {
      choose(files.filter((item) => item !== file));
      setRefused([]);
    },
    remember: (sent, recognized) => {
      const kinds = new Map(recognized.map((file) => [file.name, file.kind]));
      setDetected(new Map(sent.flatMap((file) => (kinds.has(file.name) ? [[file, kinds.get(file.name) ?? null] as const] : []))));
    },
    clearRefused: () => setRefused([]),
    clear: () => {
      setFiles([]);
      setRefused([]);
      setDetected(new Map());
    },
  };
}

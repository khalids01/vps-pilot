import { Channel, invoke } from "@tauri-apps/api/core";

export interface RemoteEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  size: number | null;
  permissions: number | null;
  modified: number | null;
  uid: number | null;
  gid: number | null;
  protected?: boolean;
}
export interface RemoteDirectory {
  path: string;
  parent: string;
  entries: RemoteEntry[];
  truncated: boolean;
}
export interface RemoteText {
  path: string;
  content: string;
  revision: string;
  size: number;
  permissions: number | null;
}
export interface FileReview {
  token: string;
  profileId: string;
  serverName: string;
  path: string;
  backupPath: string | null;
  operation: "edit" | "upload";
  bytes: number;
  expiresInSeconds: number;
}
export interface FileReceipt {
  path: string;
  backupPath: string | null;
  revision: string;
}
export const filesApi = {
  list: (profileId: string, path: string) =>
    invoke<RemoteDirectory>("ssh_files_list", { profileId, path }),
  read: (profileId: string, path: string) =>
    invoke<RemoteText>("ssh_file_read", { profileId, path }),
  review: (profileId: string, file: RemoteText, content: string) =>
    invoke<FileReview>("ssh_file_review", {
      profileId,
      path: file.path,
      revision: file.revision,
      content,
    }),
  commit: (profileId: string, token: string) =>
    invoke<FileReceipt>("ssh_file_commit", { profileId, token }),
  reject: (profileId: string, token: string) =>
    invoke<void>("ssh_file_reject", { profileId, token }),
  upload: (profileId: string, directory: string, name: string | null) =>
    invoke<FileReview | null>("ssh_file_upload", {
      profileId,
      directory,
      name,
    }),
  download: (profileId: string, path: string) =>
    invoke<boolean>("ssh_file_download", { profileId, path }),
};

export type FileOperation =
  | "copy"
  | "move"
  | "trash"
  | "restore"
  | "mkdir"
  | "download";
export interface OperationInput {
  kind: FileOperation;
  paths: string[];
  destination: string | null;
  name: string | null;
}
export interface OperationReview {
  token: string;
  profileId: string;
  serverName: string;
  operation: FileOperation;
  items: { source: string; destination: string | null; kind: string }[];
  entries: number;
  bytes: number;
  expiresInSeconds: number;
  excludedEntries: number;
  localDestination: string | null;
}
export interface OperationProgress {
  completed: number;
  total: number;
  bytes: number;
  current: string;
}
export interface OperationResult {
  status: "completed" | "cancelled" | "failed";
  completed: {
    source: string;
    destination: string | null;
    restoreId: string | null;
  }[];
  retained: string[];
  error: string | null;
}
export interface FolderSize {
  path: string;
  bytes: number;
  entries: number;
  complete: boolean;
  observedAt: number;
}
export type FileRunner = <T>(
  label: string,
  operation: () => Promise<T>,
  done: (result: T) => void,
) => Promise<boolean | undefined>;
export const managerApi = {
  review: (profileId: string, input: OperationInput) =>
    invoke<OperationReview | null>("ssh_files_review_operation", {
      profileId,
      input,
    }),
  execute: (
    profileId: string,
    token: string,
    progress: (progress: OperationProgress) => void,
  ) => {
    const output = new Channel<OperationProgress>();
    output.onmessage = progress;
    return invoke<OperationResult>("ssh_files_execute_operation", {
      profileId,
      token,
      output,
    });
  },
  reject: (profileId: string, token: string) =>
    invoke<void>("ssh_files_reject_operation", { profileId, token }),
  cancel: (profileId: string) =>
    invoke<boolean>("ssh_files_cancel", { profileId }),
  size: (profileId: string, path: string) =>
    invoke<FolderSize>("ssh_files_size", { profileId, path }),
};

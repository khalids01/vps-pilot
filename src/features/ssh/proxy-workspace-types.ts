export interface ProxyInstance {
  id: string;
  identity: string;
  manager: "caddy" | "nginx" | "traefik";
  kind: "system" | "docker";
  name: string;
  status: string;
  config: string;
  roots: { host: string; container: string; directory: boolean }[];
  editable: boolean;
  actions: boolean;
  message?: string;
  composeProject?: string;
  composeService?: string;
  labelRoutes?: boolean;
}
export interface ProxyFile {
  path: string;
  content: string;
  revision: string;
  editable: boolean;
  target?: string;
}
export interface ProxyResult {
  instances?: ProxyInstance[];
  warnings?: string[];
  instance?: ProxyInstance;
  files?: ProxyFile[];
  treeRevision?: string;
  message?: string;
  logs?: string;
  backupId?: string;
}
export type ProxyOperation =
  | "inventory"
  | "open"
  | "logs"
  | "validate"
  | "save"
  | "reload"
  | "restart"
  | "restore";
export interface ProxyIntent {
  operation: ProxyOperation;
  instanceId?: string;
  identity?: string;
  path?: string;
  revision?: string;
  treeRevision?: string;
  content?: string;
  backupId?: string;
  acknowledgeTraefik?: boolean;
}

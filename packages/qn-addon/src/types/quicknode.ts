export interface QuickNodeProvisionRequest {
  'quicknode-id': string;
  'endpoint-id': string;
  'wss-url': string;
  'http-url': string;
  chain: string;
  network: string;
  plan: string;
  referers: string[];
  'contract-addresses': string[];
}

export interface QuickNodeUpdateRequest {
  'quicknode-id': string;
  'endpoint-id': string;
  'wss-url': string;
  'http-url': string;
  chain: string;
  network: string;
  plan: string;
  referers: string[];
  'contract-addresses': string[];
}

export interface QuickNodeDeprovisionRequest {
  'quicknode-id': string;
  'endpoint-id': string;
}

export interface QuickNodeDeactivateRequest {
  'quicknode-id': string;
  'endpoint-id': string;
}

export interface QuickNodeProvisionResponse {
  status: string;
  'dashboard-url': string;
  'access-url': string;
}

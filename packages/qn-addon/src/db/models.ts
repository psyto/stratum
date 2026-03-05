export interface Instance {
  id: string;
  quicknode_id: string;
  plan: string;
  endpoint_id: string | null;
  chain: string | null;
  network: string | null;
  wss_url: string | null;
  http_url: string | null;
  referers: string;
  contract_addresses: string;
  status: string;
  deactivated_at: string | null;
  created_at: string;
  updated_at: string;
}

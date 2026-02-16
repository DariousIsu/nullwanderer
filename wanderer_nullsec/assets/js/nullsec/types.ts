export interface IntelEntry {
  solar_system_id: number;
  name: string;
  region_name: string;
  constellation_name: string | null;
  security: number;
  distance_ly: number;
  gate_jumps: number | null;
  gate_route: number[] | null;
  sov_alliance_id: number | null;
  sov_alliance_ticker: string | null;
  sov_faction_id: number | null;
  adm_value: number | null;
  npc_kills: number;
  npc_kills_delta: number;
  ship_kills: number;
  ship_kills_delta: number;
  pod_kills: number;
  pod_kills_delta: number;
  jumps_per_hour: number;
  jumps_delta: number;
  mining_cost_index: number | null;
  mining_cost_delta: number | null;
  pvp_ship_count_1hr: number;
  pvp_kills_1hr: PvPKill[];
  last_updated: string;
}

export interface PvPKill {
  kill_id: number;
  kill_time: string | null;
  victim_ship_type_id: number | null;
  attacker_count: number | null;
  total_value: number;
  npc: boolean;
  solo: boolean;
}

export type SortField = keyof Pick<
  IntelEntry,
  | 'name' | 'distance_ly' | 'gate_jumps' | 'sov_alliance_ticker'
  | 'npc_kills_delta' | 'mining_cost_delta' | 'jumps_per_hour'
  | 'pvp_ship_count_1hr' | 'security' | 'region_name' | 'adm_value'
>;
export type SortDir = 'asc' | 'desc';

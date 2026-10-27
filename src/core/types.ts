export interface Place {
  id: string; name: string; zone: string; lat: number; lon: number;
  coordinateStatus: string; coordinateSource?: string; sourceUrl?: string;
  pointType?: string; coordinateCheckedAt?: string; coordinateCheckNote?: string;
}
export interface Catalog { title: string; generatedAt: string; places: Place[]; [key: string]: unknown }
export interface WalkingMatrix {
  placeIds: string[]; distancesMeters: (number | null)[][];
  durationsSeconds?: (number | null)[][] | null;
  retrievedAt?: string; catalogFingerprint?: string;
  engine?: string; costing?: string; unitsReceived?: string;
  requestCount?: number; maxPairsPerRequest?: number; minimumRequestGapMs?: number;
}
export interface Scenario {
  startId: string; budgetMinutes: number; visitMinutes: number;
  walkingSpeedKmh: number; zoneNeighborThresholdMinutes: number;
}
export interface PlannerInput extends Omit<Scenario, 'zoneNeighborThresholdMinutes'> {
  places: Place[]; matrix: WalkingMatrix; zoneNeighborThresholdMinutes?: number;
  zoneAdjacency?: Map<string, Set<string>>;
}
export interface Segment { fromId: string; toId: string; distanceMeters: number; walkMinutes: number }
export interface RouteResult {
  stops: Place[]; segments: Segment[]; totalWalkDistanceMeters: number; totalWalkMinutes: number;
  totalVisitMinutes: number; totalMinutes: number; budgetMinutes: number; budgetCompliant: boolean;
  overrunMinutes: number; zoneSequence: string[]; zoneReentryCount: number; zoneTransitionCount: number;
  uniqueZonesVisited: number; zoneCoverageRatio: number; endZoneDiffersFromStart: boolean;
}
export interface RouteComparison { id: string; label: string; result: RouteResult }
export type Coordinate = [number, number];

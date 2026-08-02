export interface WorkbenchArtifact {
  id: string;
  type: string;
  content: string;
  metadata?: Record<string, any>;
}

export interface WorkbenchSessionState {
  sessionId: string;
  artifacts: WorkbenchArtifact[];
  status: 'active' | 'archived';
  createdAt: number;
}

export interface WorkbenchLedgerEntry {
  entryId: string;
  sessionId: string;
  action: string;
  timestamp: number;
  payload?: any;
}

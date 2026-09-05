export type Role = 'USER' | 'ADMIN' | 'SUPER_ADMIN';

export type Language = 'BM' | 'EN';

export type ThemeMode = 'dark' | 'light' | 'system';

export type VehicleStatus = 'ACTIVE' | 'FLAGGED' | 'PENDING' | 'CLEARED';

export type VehiclePriority = 'HIGH' | 'MEDIUM' | 'LOW';

export interface Vehicle {
  id: string;
  plate: string;
  customerName: string;
  customerId: string;
  phone: string;
  brand: string;
  model: string;
  colour: string;
  year: number;
  financeCompany: string;
  outstandingAmount: number;
  reference: string;
  priority: VehiclePriority;
  status: VehicleStatus;
  remark: string;
  createdDate: string;
  updatedDate: string;
}

export interface UserAccount {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: Role;
  status: 'ACTIVE' | 'DISABLED';
  avatar: string;
  lastLogin: string;
  createdBy?: string;
}

export interface CameraDevice {
  id: string;
  name: string;
  location: string;
  status: 'ONLINE' | 'OFFLINE';
  type: 'RTSP' | 'USB' | 'WEBCAM';
  url: string;
  fps: number;
  resolution: string;
}

export interface DetectionLog {
  id: string;
  plate: string;
  confidence: number;
  matched: boolean;
  vehicleId?: string;
  timestamp: string;
  cameraId: string;
  cameraName: string;
  snapshotPlaceholder?: string;
  snapshotDataUrl?: string;
  actionStatus?: 'PENDING' | 'REVIEWED';
  actionedAt?: string;
  actionedBy?: string;
}

export interface HistoryLog {
  id: string;
  type: 'SEARCH' | 'DETECTION' | 'VEHICLE' | 'USER';
  action: string;
  plate?: string;
  details: string;
  userRole: Role;
  timestamp: string;
  statusMatch?: 'EXACT' | 'POSSIBLE' | 'NONE';
  note?: string;
  cameraId?: string;
  cameraName?: string;
  actorId?: string;
  actorName?: string;
}

export interface SystemSettings {
  detectionConfidence: number;
  ocrConfidence: number;
  soundAlerts: boolean;
  autoRefreshRate: number;
}

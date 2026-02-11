
export interface AppointmentData {
  patientName: string;
  phone: string;
  packageType: string;
  date: string;
  time: string;
  medicalConditions?: string;
}

export enum CallStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  ACTIVE = 'ACTIVE',
  ENDED = 'ENDED',
  ERROR = 'ERROR'
}

export interface PackageInfo {
  id: string;
  name: string;
  price: string;
  duration: string;
  features: string[];
  idealFor: string;
}

'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  Vehicle,
  UserAccount,
  CameraDevice,
  HistoryLog,
  SystemSettings,
  ThemeMode,
  VehiclePriority,
  VehicleStatus,
} from '@/types';
import {
  initialVehicles,
  initialUsers,
  initialCameras,
  initialHistory,
  defaultSettings,
} from '@/lib/mockData';
import { cleanPlateNumber, downloadCSV, formatDate } from '@/lib/utils';

interface StorageContextType {
  vehicles: Vehicle[];
  users: UserAccount[];
  cameras: CameraDevice[];
  history: HistoryLog[];
  settings: SystemSettings;
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  addVehicle: (v: Omit<Vehicle, 'id' | 'createdDate' | 'updatedDate'>) => Vehicle;
  updateVehicle: (v: Vehicle) => void;
  deleteVehicle: (id: string) => void;
  importVehiclesCSV: (csvText: string) => number;
  exportVehiclesCSV: () => void;
  searchVehicles: (query: string) => { exactMatch: Vehicle | null; possibleMatches: Vehicle[] };
  addUser: (u: Omit<UserAccount, 'id' | 'lastLogin'>) => UserAccount;
  updateUser: (u: UserAccount) => void;
  toggleUserStatus: (id: string) => void;
  deleteUser: (id: string) => void;
  updateCamera: (c: CameraDevice) => void;
  addHistoryLog: (log: Omit<HistoryLog, 'id' | 'timestamp'>) => void;
  clearHistory: () => void;
  exportHistoryCSV: () => void;
  updateSettings: (s: Partial<SystemSettings>) => void;
}

const StorageContext = createContext<StorageContextType | undefined>(undefined);

type StoredSystemSettings = Partial<SystemSettings> & { debugMode?: unknown };

function readJsonStorage<T>(key: string, fallback: T, merge?: (stored: T) => T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return fallback;
    const parsed = JSON.parse(stored) as T;
    return merge ? merge(parsed) : parsed;
  } catch (error) {
    console.error(`Error restoring ${key} from LocalStorage:`, error);
    return fallback;
  }
}

function readThemeStorage(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  const storedTheme = localStorage.getItem('track_theme') as ThemeMode | null;
  return storedTheme === 'dark' || storedTheme === 'light' || storedTheme === 'system' ? storedTheme : 'dark';
}

function mergeStoredUsers(storedUsers: UserAccount[]): UserAccount[] {
  const migratedUsers = storedUsers.map((user) => ({
    ...user,
    createdBy:
      user.createdBy ||
      (user.id === 'user-002'
        ? 'user-001'
        : user.id === 'user-003'
        ? 'user-002'
        : user.role === 'SUPER_ADMIN'
        ? 'system'
        : undefined),
  }));
  return [
    ...migratedUsers,
    ...initialUsers.filter((seedUser) => !migratedUsers.some((storedUser) => storedUser.id === seedUser.id)),
  ];
}

function mergeStoredHistory(storedHistory: HistoryLog[]): HistoryLog[] {
  return [
    ...storedHistory,
    ...initialHistory.filter((seedLog) => !storedHistory.some((storedLog) => storedLog.id === seedLog.id)),
  ];
}

function sanitizeSystemSettings(rawSettings: StoredSystemSettings): SystemSettings {
  const cleanedSettings: StoredSystemSettings = { ...rawSettings };
  delete cleanedSettings.debugMode;
  return { ...defaultSettings, ...cleanedSettings };
}

function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const prefersDark =
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (mode === 'dark' || (mode === 'system' && prefersDark)) {
    root.classList.add('dark');
    root.classList.remove('light');
  } else {
    root.classList.remove('dark');
    root.classList.add('light');
  }
}

function createLocalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function createTimestampedCsvName(prefix: string): string {
  return `${prefix}_${Date.now()}.csv`;
}

function parseVehiclePriority(value: string | undefined): VehiclePriority {
  return value === 'HIGH' || value === 'MEDIUM' || value === 'LOW' ? value : 'HIGH';
}

function parseVehicleStatus(value: string | undefined): VehicleStatus {
  return value === 'ACTIVE' || value === 'FLAGGED' || value === 'PENDING' || value === 'CLEARED'
    ? value
    : 'ACTIVE';
}

export const StorageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [vehicles, setVehicles] = useState<Vehicle[]>(initialVehicles);
  const [users, setUsers] = useState<UserAccount[]>(initialUsers);
  const [cameras, setCameras] = useState<CameraDevice[]>(initialCameras);
  const [history, setHistory] = useState<HistoryLog[]>(initialHistory);
  const [settings, setSettings] = useState<SystemSettings>(defaultSettings);
  const [theme, setThemeState] = useState<ThemeMode>('dark');

  useEffect(() => {
    const id = window.setTimeout(() => {
      setVehicles(readJsonStorage('track_vehicles', initialVehicles));
      setUsers(readJsonStorage('track_users', initialUsers, mergeStoredUsers));
      setCameras(readJsonStorage('track_cameras', initialCameras));
      setHistory(readJsonStorage('track_history', initialHistory, mergeStoredHistory));
      setSettings(readJsonStorage('track_settings', defaultSettings, sanitizeSystemSettings));
      setThemeState(readThemeStorage());
    }, 0);

    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = (mode: ThemeMode) => {
    setThemeState(mode);
    localStorage.setItem('track_theme', mode);
    applyTheme(mode);
  };

  // Helper save functions
  const saveVehicles = (data: Vehicle[]) => {
    setVehicles(data);
    localStorage.setItem('track_vehicles', JSON.stringify(data));
  };

  const updateStoredVehicles = (updater: (currentVehicles: Vehicle[]) => Vehicle[]) => {
    setVehicles((currentVehicles) => {
      const updated = updater(currentVehicles);
      localStorage.setItem('track_vehicles', JSON.stringify(updated));
      return updated;
    });
  };

  const saveUsers = (data: UserAccount[]) => {
    setUsers(data);
    localStorage.setItem('track_users', JSON.stringify(data));
  };

  const saveCameras = (data: CameraDevice[]) => {
    setCameras(data);
    localStorage.setItem('track_cameras', JSON.stringify(data));
  };

  const saveHistory = (data: HistoryLog[]) => {
    setHistory(data);
    localStorage.setItem('track_history', JSON.stringify(data));
  };

  const updateStoredHistory = (updater: (currentHistory: HistoryLog[]) => HistoryLog[]) => {
    setHistory((currentHistory) => {
      const updated = updater(currentHistory);
      localStorage.setItem('track_history', JSON.stringify(updated));
      return updated;
    });
  };

  // Vehicle CRUD
  const addVehicle = (vData: Omit<Vehicle, 'id' | 'createdDate' | 'updatedDate'>): Vehicle => {
    const now = new Date().toISOString();
    const newVehicle: Vehicle = {
      ...vData,
      id: createLocalId('veh'),
      plate: cleanPlateNumber(vData.plate),
      createdDate: now,
      updatedDate: now,
    };
    const updated = [newVehicle, ...vehicles];
    saveVehicles(updated);
    addHistoryLog({
      type: 'VEHICLE',
      action: `Added Vehicle: ${newVehicle.plate}`,
      plate: newVehicle.plate,
      details: `${newVehicle.brand} ${newVehicle.model} (${newVehicle.financeCompany})`,
      userRole: 'ADMIN',
    });
    return newVehicle;
  };

  const updateVehicle = (v: Vehicle) => {
    updateStoredVehicles((currentVehicles) =>
      currentVehicles.map((item) =>
        item.id === v.id
          ? { ...v, plate: cleanPlateNumber(v.plate), updatedDate: new Date().toISOString() }
          : item
      )
    );
    addHistoryLog({
      type: 'VEHICLE',
      action: `Updated Vehicle: ${v.plate}`,
      plate: v.plate,
      details: `Status: ${v.status}, Priority: ${v.priority}`,
      userRole: 'ADMIN',
    });
  };

  const deleteVehicle = (id: string) => {
    const v = vehicles.find((x) => x.id === id);
    const updated = vehicles.filter((x) => x.id !== id);
    saveVehicles(updated);
    if (v) {
      addHistoryLog({
        type: 'VEHICLE',
        action: `Deleted Vehicle: ${v.plate}`,
        plate: v.plate,
        details: `Deleted by Admin`,
        userRole: 'ADMIN',
      });
    }
  };

  const searchVehicles = (query: string) => {
    const cleaned = cleanPlateNumber(query);
    if (!cleaned) return { exactMatch: null, possibleMatches: [] };

    const exactMatch = vehicles.find((v) => cleanPlateNumber(v.plate) === cleaned) || null;
    const possibleMatches = vehicles.filter((v) => {
      const p = cleanPlateNumber(v.plate);
      const c = v.customerName.toLowerCase();
      const ref = v.reference.toLowerCase();
      const q = query.toLowerCase();
      return (p.includes(cleaned) || c.includes(q) || ref.includes(q)) && v.id !== exactMatch?.id;
    });

    return { exactMatch, possibleMatches };
  };

  const importVehiclesCSV = (csvText: string): number => {
    try {
      const lines = csvText.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length <= 1) return 0;
      
      const newEntries: Vehicle[] = [];
      const now = new Date().toISOString();

      lines.slice(1).forEach((line, idx) => {
        const parts = line.split(',').map((p) => p.replace(/^"|"$/g, '').trim());
        if (parts.length >= 2 && parts[0]) {
          newEntries.push({
            id: `imp-${Date.now()}-${idx}`,
            plate: cleanPlateNumber(parts[0]),
            customerName: parts[1] || 'Imported Customer',
            customerId: parts[2] || `CUST-IMP-${idx}`,
            phone: parts[3] || '+60 12-0000000',
            brand: parts[4] || 'Perodua',
            model: parts[5] || 'Bezza',
            colour: parts[6] || 'White',
            year: parseInt(parts[7]) || 2021,
            financeCompany: parts[8] || 'Maybank',
            outstandingAmount: parseFloat(parts[9]) || 10000,
            reference: parts[10] || `IMP-REF-${idx}`,
            priority: parseVehiclePriority(parts[11]),
            status: parseVehicleStatus(parts[12]),
            remark: parts[13] || 'Imported via CSV',
            createdDate: now,
            updatedDate: now,
          });
        }
      });

      const merged = [...newEntries, ...vehicles];
      saveVehicles(merged);
      addHistoryLog({
        type: 'VEHICLE',
        action: `CSV Import Executed`,
        details: `Imported ${newEntries.length} new vehicle records`,
        userRole: 'SUPER_ADMIN',
      });
      return newEntries.length;
    } catch (err) {
      console.error('CSV import parse error:', err);
      return 0;
    }
  };

  const exportVehiclesCSV = () => {
    const headers = 'Plate,Customer,Customer_ID,Phone,Brand,Model,Colour,Year,Finance,Outstanding,Reference,Priority,Status,Remark,CreatedDate\n';
    const rows = vehicles
      .map(
        (v) =>
          `"${v.plate}","${v.customerName}","${v.customerId}","${v.phone}","${v.brand}","${v.model}","${v.colour}",${v.year},"${v.financeCompany}",${v.outstandingAmount},"${v.reference}","${v.priority}","${v.status}","${v.remark}","${v.createdDate}"`
      )
      .join('\n');
    downloadCSV(createTimestampedCsvName('track_vehicles'), headers + rows);
  };

  // User CRUD
  const addUser = (uData: Omit<UserAccount, 'id' | 'lastLogin'>): UserAccount => {
    const newUser: UserAccount = {
      ...uData,
      id: createLocalId('user'),
      lastLogin: new Date().toISOString(),
    };
    const updated = [newUser, ...users];
    saveUsers(updated);
    addHistoryLog({
      type: 'USER',
      action: `Created User: ${newUser.name}`,
      details: `Role: ${newUser.role}, Email: ${newUser.email}`,
      userRole: 'ADMIN',
    });
    return newUser;
  };

  const updateUser = (u: UserAccount) => {
    const updated = users.map((item) => (item.id === u.id ? u : item));
    saveUsers(updated);
    addHistoryLog({
      type: 'USER',
      action: `Updated User: ${u.name}`,
      details: `Role: ${u.role}, Status: ${u.status}`,
      userRole: 'ADMIN',
    });
  };

  const toggleUserStatus = (id: string) => {
    const updated = users.map((item) =>
      item.id === id
        ? { ...item, status: item.status === 'ACTIVE' ? ('DISABLED' as const) : ('ACTIVE' as const) }
        : item
    );
    saveUsers(updated);
  };

  const deleteUser = (id: string) => {
    const targetUser = users.find((u) => u.id === id);
    const updated = users.filter((item) => item.id !== id);
    saveUsers(updated);
    if (targetUser) {
      addHistoryLog({
        type: 'USER',
        action: `Deleted User: ${targetUser.name}`,
        details: `Deleted account (${targetUser.email})`,
        userRole: 'SUPER_ADMIN',
      });
    }
  };

  // Camera Management
  const updateCamera = (c: CameraDevice) => {
    const updated = cameras.map((item) => (item.id === c.id ? c : item));
    saveCameras(updated);
  };

  // History Audit
  const addHistoryLog = (logData: Omit<HistoryLog, 'id' | 'timestamp'>) => {
    const newLog: HistoryLog = {
      ...logData,
      id: createLocalId('hist'),
      timestamp: new Date().toISOString(),
    };
    updateStoredHistory((currentHistory) => [newLog, ...currentHistory]);
  };

  const clearHistory = () => {
    saveHistory([]);
  };

  const exportHistoryCSV = () => {
    const headers = 'ID,Type,Action,Plate,Details,UserRole,Timestamp,MatchStatus,CameraID,CameraName\n';
    const rows = history
      .map(
        (h) =>
          `"${h.id}","${h.type}","${h.action}","${h.plate || ''}","${h.details}","${h.userRole}","${formatDate(
            h.timestamp
          )}","${h.statusMatch || ''}","${h.cameraId || ''}","${h.cameraName || ''}"`
      )
      .join('\n');
    downloadCSV(createTimestampedCsvName('track_audit_history'), headers + rows);
  };

  // Settings
  const updateSettings = (s: Partial<SystemSettings>) => {
    const updated = sanitizeSystemSettings({ ...settings, ...s });
    setSettings(updated);
    localStorage.setItem('track_settings', JSON.stringify(updated));
  };

  return (
    <StorageContext.Provider
      value={{
        vehicles,
        users,
        cameras,
        history,
        settings,
        theme,
        setTheme,
        addVehicle,
        updateVehicle,
        deleteVehicle,
        importVehiclesCSV,
        exportVehiclesCSV,
        searchVehicles,
        addUser,
        updateUser,
        toggleUserStatus,
        deleteUser,
        updateCamera,
        addHistoryLog,
        clearHistory,
        exportHistoryCSV,
        updateSettings,
      }}
    >
      {children}
    </StorageContext.Provider>
  );
};

export const useStorage = () => {
  const context = useContext(StorageContext);
  if (!context) {
    throw new Error('useStorage must be used within a StorageProvider');
  }
  return context;
};

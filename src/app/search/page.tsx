'use client';

import React, { Fragment, useEffect, useRef, useState } from 'react';
import { useStorage } from '@/context/StorageContext';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { cleanPlateNumber, formatMYR, formatDate } from '@/lib/utils';
import { Vehicle } from '@/types';
import {
  Search as SearchIcon,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Building2,
  User,
  FileText,
  DollarSign,
  Tag,
  BookmarkCheck,
  Clock,
  History,
  X,
} from 'lucide-react';

function formatSearchTime(isoString: string): string {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kuala_Lumpur',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .reduce<Record<string, string>>((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
      }, {});

    return `${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
  } catch {
    return isoString;
  }
}

export default function SearchPage() {
  const { searchVehicles, addHistoryLog, updateVehicle, history } = useStorage();
  const { t, language } = useLanguage();
  const { role } = useAuth();

  const [inputQuery, setInputQuery] = useState('');
  const [exactResult, setExactResult] = useState<Vehicle | null>(null);
  const [possibleResults, setPossibleResults] = useState<Vehicle[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [customActionNote, setCustomActionNote] = useState('');
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const executeSearchRef = useRef<(query: string) => void>(() => undefined);
  const isMalay = language === 'BM';
  const searchHistoryTitle = isMalay ? 'Sejarah Carian & Amaran' : 'Search & Alert History';
  const emptySearchHistoryLabel = isMalay ? 'Belum ada carian atau tindakan amaran.' : 'No searches or alert actions yet.';
  const searchHistory = history
    .filter(
      (log) =>
        log.type === 'SEARCH' ||
        (log.type === 'DETECTION' && (log.action.includes('Tanda Tindakan') || log.statusMatch === 'EXACT'))
    )
    .slice(0, 6);
  const mobileSearchHistory = searchHistory.slice(0, 4);
  const mobileSearchPlaceholder = isMalay ? 'Masukkan nombor plat' : 'Enter plate number';
  const mobileSearchLabel = isMalay ? 'Cari' : 'Search';
  const getSearchPlate = (log: (typeof searchHistory)[number]) =>
    log.plate || log.action.match(/(?:Manual Search|Manual Search Plate):\s*([A-Z0-9]+)/i)?.[1] || '-';
  const toggleHistoryDetails = (id: string) => {
    setExpandedHistoryId((current) => (current === id ? null : id));
  };

  // Auto clean plate input as user types
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputQuery(cleanPlateNumber(e.target.value));
  };

  const executeSearch = (query: string) => {
    const cleanedQuery = cleanPlateNumber(query);
    if (!cleanedQuery.trim()) return;

    setInputQuery(cleanedQuery);

    const { exactMatch, possibleMatches } = searchVehicles(cleanedQuery);
    
    // Automatically update vehicle status to FLAGGED in Vehicle Management when matched
    if (exactMatch) {
      const flaggedObj = { ...exactMatch, status: 'FLAGGED' as const };
      updateVehicle(flaggedObj);
      setExactResult(flaggedObj);
    } else {
      setExactResult(null);
    }

    setPossibleResults(possibleMatches);
    setHasSearched(true);

    // Trigger history log if exact match found
    if (exactMatch) {
      addHistoryLog({
        type: 'SEARCH',
        action: `Tanda Tindakan (Carian): ${exactMatch.plate}`,
        plate: exactMatch.plate,
        details: `Tanda Tindakan - Padanan Kes: ${exactMatch.brand} ${exactMatch.model} (${exactMatch.financeCompany} ${formatMYR(exactMatch.outstandingAmount)})`,
        note: `Match Found: ${exactMatch.brand} ${exactMatch.model} (${exactMatch.financeCompany})`,
        userRole: role,
        statusMatch: 'EXACT',
      });
    } else if (possibleMatches.length > 0) {
      addHistoryLog({
        type: 'SEARCH',
        action: `Manual Search: ${cleanedQuery}`,
        plate: cleanedQuery,
        details: `Possible Matches Found (${possibleMatches.length})`,
        userRole: role,
        statusMatch: 'POSSIBLE',
      });
    } else {
      addHistoryLog({
        type: 'SEARCH',
        action: `Manual Search: ${cleanedQuery}`,
        plate: cleanedQuery,
        details: `No Match Found`,
        userRole: role,
        statusMatch: 'NONE',
      });
    }
  };

  useEffect(() => {
    executeSearchRef.current = executeSearch;
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const plateParam = cleanPlateNumber(new URLSearchParams(window.location.search).get('plate') || '');
      if (plateParam) executeSearchRef.current(plateParam);
    }, 50);

    return () => window.clearTimeout(timer);
  }, []);

  const handleSearch = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    executeSearch(inputQuery);
  };

  const handleMarkAction = () => {
    if (exactResult) {
      const flaggedObj = { ...exactResult, status: 'FLAGGED' as const };
      updateVehicle(flaggedObj);
      setExactResult(flaggedObj);
      const actionNote = customActionNote.trim() || `Ditanda untuk tindakan Unit Tunda oleh ${role}`;
      addHistoryLog({
        type: 'SEARCH',
        action: `Tanda Tindakan (Unit Tunda): ${exactResult.plate}`,
        plate: exactResult.plate,
        details: actionNote,
        note: actionNote,
        userRole: role,
        statusMatch: 'EXACT',
      });
    }
  };

  const handleMarkPending = () => {
    if (exactResult) {
      const pendingObj = { ...exactResult, status: 'PENDING' as const };
      updateVehicle(pendingObj);
      setExactResult(pendingObj);
      const actionNote = customActionNote.trim() || `Ditanda Dalam Semakan oleh ${role}`;
      addHistoryLog({
        type: 'SEARCH',
        action: `Dalam Semakan: ${exactResult.plate}`,
        plate: exactResult.plate,
        details: actionNote,
        note: actionNote,
        userRole: role,
        statusMatch: 'POSSIBLE',
      });
    }
  };

  const handleMarkCleared = () => {
    if (exactResult) {
      const clearedObj = { ...exactResult, status: 'CLEARED' as const };
      updateVehicle(clearedObj);
      setExactResult(clearedObj);
      const actionNote = customActionNote.trim() || `Kes Diselesaikan oleh ${role}`;
      addHistoryLog({
        type: 'SEARCH',
        action: `Kes Selesai: ${exactResult.plate}`,
        plate: exactResult.plate,
        details: actionNote,
        note: actionNote,
        userRole: role,
        statusMatch: 'NONE',
      });
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-5 sm:space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <h1 className="text-2xl sm:text-2xl font-black text-white tracking-wide leading-tight">
          {t('searchTitle')}
        </h1>
      </div>

      {/* Search Bar Container */}
      <form
        onSubmit={handleSearch}
        className="bg-slate-900/90 border border-cyan-900/50 rounded-xl sm:rounded-2xl p-4 shadow-xl backdrop-blur-md"
      >
        {/* Input + Button */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="relative flex-1 min-w-0">
            <input
              type="text"
              value={inputQuery}
              onChange={handleInputChange}
              placeholder={mobileSearchPlaceholder}
              className="w-full bg-slate-950 border-2 border-cyan-500/40 rounded-xl px-4 py-3 text-base sm:text-xl font-mono font-black uppercase text-cyan-300 placeholder:text-slate-600 focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 transition-all sm:tracking-wider"
              autoFocus
            />
            {inputQuery && (
              <span className="hidden sm:inline-block absolute right-3 top-3.5 text-[9px] font-mono font-bold uppercase tracking-wider text-slate-500 bg-slate-900 px-2 py-0.5 rounded border border-slate-800 pointer-events-none">
                AUTO-FORMATTED
              </span>
            )}
          </div>
          <button
            type="submit"
            className="w-full sm:w-auto px-5 sm:px-6 py-3.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-black text-sm uppercase tracking-wider shadow-lg shadow-cyan-500/20 transition-all shrink-0 flex items-center justify-center gap-2"
          >
            <SearchIcon className="w-4 h-4 sm:w-5 sm:h-5" />
            <span className="sm:hidden">{mobileSearchLabel}</span>
            <span className="hidden sm:inline">{t('searchBtn')}</span>
          </button>
        </div>
      </form>

      <div className="bg-slate-900/90 border border-slate-800 rounded-xl sm:rounded-2xl p-4 shadow-xl space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">
              {searchHistoryTitle}
            </h2>
          </div>
          <span className="text-[10px] font-mono text-slate-500">
            {searchHistory.length} recent
          </span>
        </div>

        <div className="sm:hidden space-y-3">
          {mobileSearchHistory.length > 0 ? (
            mobileSearchHistory.map((log) => (
              <button
                key={log.id}
                type="button"
                onClick={() => toggleHistoryDetails(log.id)}
                className="w-full text-left p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2.5 hover:border-cyan-900/70 transition-all"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate font-mono font-black text-cyan-300 text-lg leading-none">{getSearchPlate(log)}</span>
                  <span
                    className={`shrink-0 px-2 py-1 rounded-md border text-[10px] font-bold uppercase ${
                      log.statusMatch === 'EXACT'
                        ? 'bg-red-950/70 text-red-300 border-red-800'
                        : log.statusMatch === 'POSSIBLE'
                        ? 'bg-amber-950/70 text-amber-300 border-amber-800'
                        : 'bg-slate-950 text-slate-400 border-slate-700'
                    }`}
                  >
                    {log.statusMatch === 'EXACT' ? 'Found' : log.statusMatch === 'POSSIBLE' ? 'Possible' : 'No Match'}
                  </span>
                </div>
                <p className="text-[13px] leading-snug text-slate-300">{log.note || log.details}</p>
                <div className="text-[11px] text-slate-500 font-mono">{formatSearchTime(log.timestamp)}</div>
                {expandedHistoryId === log.id && (
                  <div className="mt-3 pt-3 border-t border-slate-800 grid grid-cols-1 gap-1.5 text-[11px] text-slate-400">
                    <div><span className="text-slate-500">Action:</span> {log.action}</div>
                    <div><span className="text-slate-500">Details:</span> {log.details}</div>
                    {log.note && <div><span className="text-slate-500">Note:</span> {log.note}</div>}
                    <div><span className="text-slate-500">Last Dijumpai:</span> {formatSearchTime(log.timestamp)}</div>
                  </div>
                )}
              </button>
            ))
          ) : (
            <div className="py-5 text-center text-xs text-slate-500">{emptySearchHistoryLabel}</div>
          )}
        </div>

        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[560px]">
            <thead className="bg-slate-950 text-slate-400 uppercase font-mono text-[10px] border-b border-slate-800 whitespace-nowrap">
              <tr>
                <th className="py-2.5 px-3">{t('plateNumber')}</th>
                <th className="py-2.5 px-3">{t('matchDetails')}</th>
                <th className="py-2.5 px-3 text-center">Result</th>
                <th className="py-2.5 px-3 text-right">{t('timestamp')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {searchHistory.length > 0 ? (
                searchHistory.map((log) => (
                  <Fragment key={log.id}>
                    <tr
                      onClick={() => toggleHistoryDetails(log.id)}
                      className="hover:bg-slate-800/40 transition-colors cursor-pointer"
                    >
                      <td className="py-2.5 px-3 font-mono font-black text-cyan-300">{getSearchPlate(log)}</td>
                      <td className="py-2.5 px-3 text-slate-300 font-medium truncate max-w-[320px]">
                        {log.note || log.details}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        <span
                          className={`inline-flex items-center justify-center w-24 h-6 rounded-md border text-[9px] font-bold uppercase ${
                            log.statusMatch === 'EXACT'
                              ? 'bg-red-950/70 text-red-300 border-red-800'
                              : log.statusMatch === 'POSSIBLE'
                              ? 'bg-amber-950/70 text-amber-300 border-amber-800'
                              : 'bg-slate-950 text-slate-400 border-slate-700'
                          }`}
                        >
                          {log.statusMatch === 'EXACT' ? 'Found' : log.statusMatch === 'POSSIBLE' ? 'Possible' : 'No Match'}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-500 font-mono text-[11px]">
                        {formatDate(log.timestamp)}
                      </td>
                    </tr>
                    {expandedHistoryId === log.id && (
                      <tr className="bg-slate-950/70">
                        <td colSpan={4} className="px-3 py-3">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px] text-slate-400">
                            <div><span className="text-slate-500">Action:</span> {log.action}</div>
                            <div><span className="text-slate-500">Last Dijumpai:</span> {formatDate(log.timestamp)}</div>
                            <div className="md:col-span-2"><span className="text-slate-500">Details:</span> {log.details}</div>
                            {log.note && <div className="md:col-span-2"><span className="text-slate-500">Note:</span> {log.note}</div>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-slate-500">
                    {emptySearchHistoryLabel}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Results Section */}
      {hasSearched && (
        <div className="space-y-3 sm:space-y-6">
          {/* 1. EXACT MATCH CRITICAL ALERT CARD */}
          {exactResult ? (
            <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md p-3 sm:p-6 flex items-center justify-center">
            <div className="relative w-full max-w-3xl overflow-hidden rounded-2xl border border-red-500/70 bg-slate-900 shadow-2xl shadow-red-950/30">
              <button
                type="button"
                onClick={() => {
                  setExactResult(null);
                  setHasSearched(false);
                }}
                className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-950/95 text-slate-400 transition-all hover:border-slate-500 hover:text-white"
                title={t('closeBtn')}
                aria-label={t('closeBtn')}
              >
                <X className="w-5 h-5" />
              </button>

              <div className="space-y-3 p-4 sm:space-y-5 sm:p-6">
                <div className="flex items-start gap-3 border-b border-red-900/40 pb-3 pr-12 sm:pb-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-red-500/60 bg-red-950 text-red-300 sm:h-10 sm:w-10">
                    <ShieldAlert className="h-4.5 w-4.5 sm:h-5 sm:w-5" />
                  </div>
                  <div className="min-w-0 space-y-1.5 sm:space-y-2">
                    <div>
                      <div className="text-[10px] font-black uppercase tracking-widest text-red-300">
                        {t('criticalAlert')}
                      </div>
                      <h2 className="text-lg font-black leading-tight text-white sm:text-2xl">
                        {t('matchFound')}
                      </h2>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-md border border-red-500/60 bg-red-950 px-2.5 py-1 text-[10px] font-black uppercase text-red-300">
                        {exactResult.status === 'ACTIVE'
                          ? t('statusActive')
                          : exactResult.status === 'FLAGGED'
                          ? t('statusFlagged')
                          : exactResult.status === 'PENDING'
                          ? t('statusPending')
                          : t('statusCleared')}
                      </span>
                      <span className="rounded-md border border-amber-500/60 bg-amber-950 px-2.5 py-1 text-[10px] font-black uppercase text-amber-300">
                        {exactResult.priority === 'HIGH'
                          ? t('priorityHigh')
                          : exactResult.priority === 'MEDIUM'
                          ? t('priorityMedium')
                          : t('priorityLow')}
                      </span>
                    </div>
                  </div>
                </div>

                <section className="rounded-xl border border-slate-800 bg-slate-950/80 p-3 sm:rounded-2xl sm:p-4">
                  <div className="grid grid-cols-1 gap-3 sm:flex sm:items-start sm:justify-between sm:gap-4">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        <Tag className="h-3.5 w-3.5 text-cyan-300" />
                        <span>{t('plateNumber')}</span>
                      </div>
                      <div className="font-mono text-2xl font-black leading-none text-cyan-300 sm:text-3xl">
                        {exactResult.plate}
                      </div>
                      <div className="text-sm font-bold text-white">
                        {exactResult.brand} {exactResult.model}
                      </div>
                      <div className="text-xs text-slate-400">
                        {exactResult.colour} ({exactResult.year})
                      </div>
                    </div>

                    <div className="rounded-xl border border-red-900/60 bg-red-950/30 p-3 sm:min-w-56 sm:text-right">
                      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-red-200 sm:justify-end">
                        <DollarSign className="h-3.5 w-3.5 text-red-300" />
                        <span>{t('outstandingAmount')}</span>
                      </div>
                      <div className="mt-1 font-mono text-xl font-black leading-none text-red-300 sm:mt-2 sm:text-2xl">
                        {formatMYR(exactResult.outstandingAmount)}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 sm:rounded-2xl sm:p-4">
                  <h3 className="mb-3 text-xs font-black uppercase tracking-wider text-slate-300">
                    {language === 'BM' ? 'Maklumat Kes' : 'Case Details'}
                  </h3>
                  <div className="grid grid-cols-2 gap-3 sm:divide-y sm:divide-slate-800/70">
                    {[
                      { label: t('customerName'), value: exactResult.customerName, detail: exactResult.phone, icon: User },
                      { label: t('financeCompany'), value: exactResult.financeCompany, detail: `Ref: ${exactResult.reference}`, icon: Building2 },
                      { label: t('caseReference'), value: exactResult.reference, detail: exactResult.remark, icon: FileText },
                    ].map((item) => {
                      const DetailIcon = item.icon;
                      return (
                        <div key={item.label} className="flex min-w-0 gap-2 sm:gap-3 sm:py-3 sm:first:pt-0 sm:last:pb-0">
                          <DetailIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300 sm:h-4 sm:w-4" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[9px] font-bold uppercase tracking-wider text-slate-500 sm:text-[10px]">
                              {item.label}
                            </div>
                            <div className="mt-1 truncate text-sm font-bold leading-tight text-white">
                              {item.value}
                            </div>
                            <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-slate-400 sm:text-xs">
                              {item.detail}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="hidden rounded-2xl border border-cyan-900/50 bg-slate-950/70 p-4 sm:block">
                  <label className="block text-xs font-bold text-cyan-300">
                    {t('notaTindakanCol')} ({language === 'BM' ? 'Pilihan' : 'Optional'})
                  </label>
                  <input
                    type="text"
                    value={customActionNote}
                    onChange={(e) => setCustomActionNote(e.target.value)}
                    placeholder={t('notaTindakanPlaceholder')}
                    className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-900 px-3.5 py-3 text-sm text-white placeholder:text-slate-500 transition-all focus:outline-none focus:border-cyan-500"
                  />
                </section>

                <div className="grid grid-cols-3 gap-2 border-t border-slate-800 pt-3 sm:gap-3 sm:pt-4">
                  <button
                    onClick={handleMarkAction}
                    className={`min-h-11 rounded-xl border px-2 py-2 text-[11px] font-black leading-tight flex flex-col items-center justify-center gap-1 transition-all sm:min-h-12 sm:flex-row sm:px-4 sm:py-3 sm:text-sm ${
                      exactResult.status === 'FLAGGED'
                        ? 'bg-red-950 border-red-500 text-red-200 shadow-sm'
                        : 'bg-red-950/70 hover:bg-red-900 border-red-800 text-red-200'
                    }`}
                  >
                    <BookmarkCheck className="w-4 h-4 text-red-300" />
                    <span>{t('markAction')}</span>
                  </button>

                  {(role === 'ADMIN' || role === 'SUPER_ADMIN') && (
                    <>
                      <button
                        onClick={handleMarkPending}
                        className={`min-h-11 rounded-xl border px-2 py-2 text-[11px] font-black leading-tight flex flex-col items-center justify-center gap-1 transition-all sm:min-h-12 sm:flex-row sm:px-4 sm:py-3 sm:text-sm ${
                          exactResult.status === 'PENDING'
                            ? 'bg-amber-950 border-amber-500 text-amber-200 shadow-sm'
                            : 'bg-amber-950/60 hover:bg-amber-900 border-amber-800 text-amber-200'
                        }`}
                      >
                        <Clock className="w-4 h-4 text-amber-300" />
                        <span>{t('statusPending')}</span>
                      </button>

                      <button
                        onClick={handleMarkCleared}
                        className={`min-h-11 rounded-xl border px-2 py-2 text-[11px] font-black leading-tight flex flex-col items-center justify-center gap-1 transition-all sm:min-h-12 sm:flex-row sm:px-4 sm:py-3 sm:text-sm ${
                          exactResult.status === 'CLEARED'
                            ? 'bg-emerald-950 border-emerald-500 text-emerald-200 shadow-sm'
                            : 'bg-emerald-950/60 hover:bg-emerald-900 border-emerald-800 text-emerald-200'
                        }`}
                      >
                        <CheckCircle2 className="w-4 h-4 text-emerald-300" />
                        <span>{t('statusCleared')}</span>
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
            </div>
          ) : possibleResults.length > 0 ? (
            /* 2. POSSIBLE MATCH CARD */
            <div className="bg-slate-900/90 border-2 border-amber-500 rounded-2xl p-6 shadow-xl space-y-4">
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-7 h-7 text-amber-400" />
                <div>
                  <h2 className="text-xl font-bold text-white">{t('possibleMatchFound')}</h2>
                  <p className="text-xs text-amber-400">
                    Found {possibleResults.length} vehicle(s) matching partial search query.
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                {possibleResults.map((v) => (
                  <div
                    key={v.id}
                    className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div>
                      <span className="font-mono font-black text-cyan-400 text-lg mr-3">
                        {v.plate}
                      </span>
                      <span className="text-xs text-slate-300 font-bold">
                        {v.customerName} ({v.brand} {v.model})
                      </span>
                      <div className="text-[11px] text-slate-400">
                        Finance: {v.financeCompany} | {formatMYR(v.outstandingAmount)}
                      </div>
                    </div>
                    <button
                      onClick={() => setExactResult(v)}
                      className="px-3 py-1.5 rounded-lg bg-cyan-950 text-cyan-400 border border-cyan-800 text-xs font-bold hover:bg-cyan-900 transition-colors shrink-0"
                    >
                      {t('openDetails')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* 3. NO MATCH CARD */
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-10 shadow-xl text-center space-y-3">
              <div className="w-14 h-14 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-center mx-auto text-slate-500">
                <XCircle className="w-8 h-8" />
              </div>
              <h2 className="text-lg font-bold text-white">{t('noMatchTitle')}</h2>
              <p className="text-xs text-slate-400 max-w-sm mx-auto">{t('noMatchDesc')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

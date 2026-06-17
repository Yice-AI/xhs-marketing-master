import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  AnalysisResult,
  BenchmarkNote,
  CollectionFollowupTask,
  ProductBrief,
  ProductBriefStatus,
  ReferenceAsset,
  RewriteSession,
  ScrapedNote,
} from '../types';
import apiClient from '../services/apiClient';
import { hasMeaningfulProductBrief, normalizeProductBrief } from '../lib/productBrief';

interface ScraperContextValue {
  showAnalysis: boolean;
  setShowAnalysis: (show: boolean) => void;
  analysisResult: AnalysisResult | null;
  setAnalysisResult: (result: AnalysisResult | null) => void;
  topNotes: ScrapedNote[];
  setTopNotes: (notes: ScrapedNote[]) => void;
  benchmarkNotes: BenchmarkNote[];
  setBenchmarkNotes: (notes: BenchmarkNote[]) => void;
  groupedBenchmarkNotes: Record<string, BenchmarkNote[]>;
  setGroupedBenchmarkNotes: (notes: Record<string, BenchmarkNote[]>) => void;
  nextCollectionTasks: CollectionFollowupTask[];
  setNextCollectionTasks: (tasks: CollectionFollowupTask[]) => void;
  realPhrases: string[];
  setRealPhrases: (phrases: string[]) => void;
  selectedBenchmarkNote: BenchmarkNote | null;
  setSelectedBenchmarkNote: (note: BenchmarkNote | null) => void;
  latestProductBrief: ProductBrief | null;
  setLatestProductBrief: (brief: ProductBrief | null) => void;
  productBriefStatus: ProductBriefStatus;
  setProductBriefStatus: React.Dispatch<React.SetStateAction<ProductBriefStatus>>;
  referenceAssets: ReferenceAsset[];
  setReferenceAssets: React.Dispatch<React.SetStateAction<ReferenceAsset[]>>;
  rewriteSession: RewriteSession | null;
  setRewriteSession: (session: RewriteSession | null) => void;
}

const ScraperContext = createContext<ScraperContextValue | null>(null);

const safeLoad = <T,>(key: string, fallback: T): T => {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return fallback;
    return JSON.parse(stored) as T;
  } catch (error) {
    console.error(`Failed to load ${key}`, error);
    return fallback;
  }
};

export const ScraperProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const productProfileHydratedRef = useRef(false);
  const productProfileSaveTimerRef = useRef<number | null>(null);
  const lastSavedProductBriefRef = useRef<string>('');
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [topNotes, setTopNotes] = useState<ScrapedNote[]>([]);
  const [benchmarkNotes, setBenchmarkNotes] = useState<BenchmarkNote[]>([]);
  const [groupedBenchmarkNotes, setGroupedBenchmarkNotes] = useState<Record<string, BenchmarkNote[]>>({});
  const [nextCollectionTasks, setNextCollectionTasks] = useState<CollectionFollowupTask[]>([]);
  const [realPhrases, setRealPhrases] = useState<string[]>([]);
  const [selectedBenchmarkNote, setSelectedBenchmarkNote] = useState<BenchmarkNote | null>(null);
  const [latestProductBrief, setLatestProductBrief] = useState<ProductBrief | null>(() => safeLoad<ProductBrief | null>('xhs_scraper_product_brief', null));
  const [productBriefStatus, setProductBriefStatus] = useState<ProductBriefStatus>(() => safeLoad<ProductBriefStatus>('xhs_scraper_product_brief_status', {
    updatedAt: null,
    analysisSignature: null,
    isDirty: false,
  }));
  const [referenceAssets, setReferenceAssets] = useState<ReferenceAsset[]>([]);
  const [rewriteSession, setRewriteSession] = useState<RewriteSession | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (latestProductBrief) {
        localStorage.setItem('xhs_scraper_product_brief', JSON.stringify(latestProductBrief));
      } else {
        localStorage.removeItem('xhs_scraper_product_brief');
      }
    } catch (error) {
      console.error('Failed to persist latestProductBrief', error);
    }
  }, [latestProductBrief]);

  useEffect(() => {
    let cancelled = false;

    const loadProductProfile = async () => {
      try {
        const response = await apiClient.getCurrentProductProfile();
        if (cancelled) return;
        const profileBrief = normalizeProductBrief(response?.data?.product_brief);
        if (hasMeaningfulProductBrief(profileBrief)) {
          lastSavedProductBriefRef.current = JSON.stringify(profileBrief);
          setLatestProductBrief(profileBrief);
          return;
        }

        const localBrief = normalizeProductBrief(safeLoad<ProductBrief | null>('xhs_scraper_product_brief', null));
        if (hasMeaningfulProductBrief(localBrief)) {
          const saveResponse = await apiClient.updateCurrentProductProfile(localBrief);
          if (cancelled) return;
          const savedBrief = normalizeProductBrief(saveResponse?.data?.product_brief || localBrief);
          lastSavedProductBriefRef.current = JSON.stringify(savedBrief);
          setLatestProductBrief(savedBrief);
        }
      } catch (error) {
        console.error('Failed to load current product profile', error);
      } finally {
        if (!cancelled) {
          productProfileHydratedRef.current = true;
        }
      }
    };

    void loadProductProfile();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!productProfileHydratedRef.current) return;
    if (!hasMeaningfulProductBrief(latestProductBrief)) return;

    const normalized = normalizeProductBrief(latestProductBrief);
    const serialized = JSON.stringify(normalized);
    if (serialized === lastSavedProductBriefRef.current) {
      return;
    }

    if (productProfileSaveTimerRef.current !== null) {
      window.clearTimeout(productProfileSaveTimerRef.current);
    }

    productProfileSaveTimerRef.current = window.setTimeout(async () => {
      try {
        const response = await apiClient.updateCurrentProductProfile(normalized);
        const savedBrief = normalizeProductBrief(response?.data?.product_brief || normalized);
        lastSavedProductBriefRef.current = JSON.stringify(savedBrief);
      } catch (error) {
        console.error('Failed to autosave current product profile', error);
      }
    }, 800);

    return () => {
      if (productProfileSaveTimerRef.current !== null) {
        window.clearTimeout(productProfileSaveTimerRef.current);
      }
    };
  }, [latestProductBrief]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem('xhs_scraper_product_brief_status', JSON.stringify(productBriefStatus));
    } catch (error) {
      console.error('Failed to persist productBriefStatus', error);
    }
  }, [productBriefStatus]);

  useEffect(() => {
    if (hasMeaningfulProductBrief(latestProductBrief)) {
      return;
    }

    let cancelled = false;

    const recoverLatestProductBrief = async () => {
      try {
        const response = await apiClient.getScrapeHistories();
        if (!response?.success || cancelled) {
          return;
        }

        const recoveredBrief = (response.data || [])
          .map((item: any) => normalizeProductBrief(item?.product_brief))
          .find((brief: ProductBrief) => hasMeaningfulProductBrief(brief));

        if (!recoveredBrief || cancelled) {
          return;
        }

        setLatestProductBrief(recoveredBrief);
      } catch (error) {
        console.error('Failed to recover latestProductBrief from scrape history', error);
      }
    };

    void recoverLatestProductBrief();

    return () => {
      cancelled = true;
    };
  }, [latestProductBrief]);

  return (
    <ScraperContext.Provider
      value={{
        showAnalysis,
        setShowAnalysis,
        analysisResult,
        setAnalysisResult,
        topNotes,
        setTopNotes,
        benchmarkNotes,
        setBenchmarkNotes,
        groupedBenchmarkNotes,
        setGroupedBenchmarkNotes,
        nextCollectionTasks,
        setNextCollectionTasks,
        realPhrases,
        setRealPhrases,
        selectedBenchmarkNote,
        setSelectedBenchmarkNote,
        latestProductBrief,
        setLatestProductBrief,
        productBriefStatus,
        setProductBriefStatus,
        referenceAssets,
        setReferenceAssets,
        rewriteSession,
        setRewriteSession,
      }}
    >
      {children}
    </ScraperContext.Provider>
  );
};

export const useScraperContext = () => {
  const context = useContext(ScraperContext);
  if (!context) {
    throw new Error('useScraperContext must be used within ScraperProvider');
  }
  return context;
};

export const useOptionalScraperContext = () => useContext(ScraperContext);

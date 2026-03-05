import React, { useState, useRef, useEffect } from 'react';
import { 
  Camera, 
  FileText, 
  Mic, 
  FileUp, 
  LogOut, 
  ChevronRight, 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  Image as ImageIcon,
  History,
  Layers,
  Trash2,
  Send
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type } from "@google/genai";

// --- Types ---
interface User {
  id: number;
  username: string;
}

interface AnalysisResult {
  [key: string]: any;
}

interface Record {
  id: number;
  type: string;
  data: AnalysisResult;
  timestamp: string;
}

interface BatchItem {
  id: string;
  type: string;
  data: string;
  mimeType: string;
  timestamp: number;
}

// --- AI Service ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

const ANALYZE_PROMPTS = {
  sensor: "Analyze this photo of a physical sensor. Identify the variable being measured (e.g., Temperature, Pressure) and its current numeric value with units. Return ONLY a JSON object with keys: 'variable', 'value', 'unit', 'confidence'.",
  sheet: "Analyze this image of a traceability sheet or board. Extract all relevant traceability data (e.g., batch numbers, dates, worker names, measurements). Return ONLY a JSON object containing these fields.",
  audio: "Transcribe this audio and extract traceability variables mentioned. Identify batch numbers, values, and status. Return ONLY a JSON object with the extracted information.",
  document: "Analyze this document content and extract all traceability data. Organize it into a structured JSON format with keys like 'batch_id', 'date', 'measurements', 'notes'."
};

const RESPONSE_SCHEMAS = {
  sensor: {
    type: Type.OBJECT,
    properties: {
      variable: { type: Type.STRING },
      value: { type: Type.NUMBER },
      unit: { type: Type.STRING },
      confidence: { type: Type.STRING }
    },
    required: ["variable", "value", "unit"]
  }
};

// --- Components ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'history'>('dashboard');
  const [records, setRecords] = useState<Record[]>([]);
  const [lastResult, setLastResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Auth State
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [batchQueue, setBatchQueue] = useState<BatchItem[]>([]);
  const [isBatchMode, setIsBatchMode] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentAction, setCurrentAction] = useState<keyof typeof ANALYZE_PROMPTS | null>(null);
  const [showSelection, setShowSelection] = useState<{ type: string, accept: string } | null>(null);

  useEffect(() => {
    if (user) {
      fetchRecords();
      const savedBatch = localStorage.getItem('amm_agro_batch');
      if (savedBatch) {
        setBatchQueue(JSON.parse(savedBatch));
      }
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      localStorage.setItem('amm_agro_batch', JSON.stringify(batchQueue));
    }
  }, [batchQueue, user]);

  const fetchRecords = async () => {
    try {
      const res = await fetch('/api/records');
      const data = await res.json();
      setRecords(data);
    } catch (err) {
      console.error("Failed to fetch records", err);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (data.success) {
        setUser(data.user);
      } else {
        setError(data.message);
      }
    } catch (err) {
      setError("Connection error");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    setUser(null);
    setLastResult(null);
    setRecords([]);
  };

  const triggerFileSelect = (type: keyof typeof ANALYZE_PROMPTS, accept: string, capture?: string) => {
    setCurrentAction(type);
    if (fileInputRef.current) {
      fileInputRef.current.accept = accept;
      if (capture) {
        fileInputRef.current.setAttribute('capture', capture);
      } else {
        fileInputRef.current.removeAttribute('capture');
      }
      fileInputRef.current.click();
    }
  };

  const processFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentAction) return;

    if (isBatchMode) {
      const base64 = await fileToBase64(file);
      const newItem: BatchItem = {
        id: crypto.randomUUID(),
        type: currentAction,
        data: base64.split(',')[1],
        mimeType: file.type,
        timestamp: Date.now()
      };
      setBatchQueue(prev => [...prev, newItem]);
      e.target.value = '';
      return;
    }

    setLoading(true);
    setError(null);
    setLastResult(null);

    try {
      const base64 = await fileToBase64(file);
      const mimeType = file.type;
      const data = base64.split(',')[1];

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            parts: [
              { text: ANALYZE_PROMPTS[currentAction] },
              { inlineData: { data, mimeType } }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json"
        }
      });

      const resultText = response.text || "{}";
      const resultJson = JSON.parse(resultText);
      
      setLastResult(resultJson);

      // Save to DB
      await fetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: currentAction, data: resultJson })
      });

      fetchRecords();
    } catch (err) {
      console.error(err);
      setError("Error processing information. Please try again.");
    } finally {
      setLoading(false);
      e.target.value = '';
    }
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = error => reject(error);
    });
  };

  const processBatch = async () => {
    if (batchQueue.length === 0) return;
    setLoading(true);
    setError(null);
    
    const results = [];
    try {
      for (const item of batchQueue) {
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [
            {
              parts: [
                { text: ANALYZE_PROMPTS[item.type as keyof typeof ANALYZE_PROMPTS] },
                { inlineData: { data: item.data, mimeType: item.mimeType } }
              ]
            }
          ],
          config: { responseMimeType: "application/json" }
        });

        const resultJson = JSON.parse(response.text || "{}");
        
        // Save to DB
        await fetch('/api/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: item.type, data: resultJson })
        });
        results.push(resultJson);
      }
      
      setBatchQueue([]);
      fetchRecords();
      setLastResult({ message: "Lote procesado con éxito", items: results.length });
    } catch (err) {
      console.error(err);
      setError("Error al procesar el lote. Algunos elementos pueden no haberse enviado.");
    } finally {
      setLoading(false);
    }
  };

  const removeFromBatch = (id: string) => {
    setBatchQueue(prev => prev.filter(item => item.id !== id));
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-6 font-sans">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md bg-white rounded-3xl shadow-xl p-8 border border-neutral-100"
        >
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center mb-4">
              <CheckCircle2 className="w-8 h-8 text-emerald-600" />
            </div>
            <h1 className="text-2xl font-bold text-neutral-900">AMM-AGRO</h1>
            <p className="text-neutral-500 text-sm">Sign in to your account</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1 ml-1">Usuario</label>
              <input 
                type="text" 
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-neutral-200 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none transition-all"
                placeholder="admin"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1 ml-1">Contraseña</label>
              <input 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-neutral-200 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none transition-all"
                placeholder="••••••••"
                required
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-red-500 text-sm bg-red-50 p-3 rounded-lg">
                <AlertCircle className="w-4 h-4" />
                <span>{error}</span>
              </div>
            )}

            <button 
              type="submit" 
              disabled={loading}
              className="w-full bg-neutral-900 text-white py-4 rounded-xl font-semibold hover:bg-neutral-800 transition-colors flex items-center justify-center gap-2 disabled:opacity-70"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Entrar'}
            </button>
          </form>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 font-sans pb-24">
      {/* Header */}
      <header className="bg-white border-bottom border-neutral-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <h2 className="text-lg font-bold text-neutral-900">AMM-AGRO</h2>
          <p className="text-xs text-neutral-500">Hola, {user.username}</p>
        </div>
        <button 
          onClick={handleLogout}
          className="p-2 text-neutral-400 hover:text-red-500 transition-colors"
        >
          <LogOut className="w-5 h-5" />
        </button>
      </header>

      <main className="p-6 max-w-2xl mx-auto">
        {activeTab === 'dashboard' ? (
          <div className="space-y-8">
            {/* Grid 2x2 */}
            <div className="grid grid-cols-2 gap-4">
              <ActionButton 
                icon={<Camera className="w-6 h-6" />}
                label="Sensor Físico"
                color="bg-blue-50 text-blue-600"
                onClick={() => setShowSelection({ type: 'sensor', accept: 'image/*' })}
              />
              <ActionButton 
                icon={<FileText className="w-6 h-6" />}
                label="Planilla/Tablero"
                color="bg-purple-50 text-purple-600"
                onClick={() => setShowSelection({ type: 'sheet', accept: 'image/*' })}
              />
              <ActionButton 
                icon={<Mic className="w-6 h-6" />}
                label="Audio Variable"
                color="bg-orange-50 text-orange-600"
                onClick={() => setShowSelection({ type: 'audio', accept: 'audio/*' })}
              />
              <ActionButton 
                icon={<FileUp className="w-6 h-6" />}
                label="Documento"
                color="bg-emerald-50 text-emerald-600"
                onClick={() => triggerFileSelect('document', '.pdf,.doc,.docx,.txt,.xlsx,.xls')}
              />
            </div>

            {/* 5th Button: Batch Mode */}
            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => setIsBatchMode(!isBatchMode)}
              className={`w-full p-4 rounded-3xl border flex items-center justify-between transition-all ${
                isBatchMode 
                ? 'bg-neutral-900 border-neutral-900 text-white shadow-lg' 
                : 'bg-white border-neutral-200 text-neutral-700 shadow-sm'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-xl ${isBatchMode ? 'bg-white/20' : 'bg-neutral-100'}`}>
                  <Layers className="w-6 h-6" />
                </div>
                <div className="text-left">
                  <span className="block text-sm font-bold">Captura en Lote</span>
                  <span className="text-[10px] opacity-70">
                    {isBatchMode ? 'MODO LOTE ACTIVADO' : 'Guardar localmente para envío posterior'}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {batchQueue.length > 0 && (
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${isBatchMode ? 'bg-white text-neutral-900' : 'bg-neutral-900 text-white'}`}>
                    {batchQueue.length}
                  </span>
                )}
                <ChevronRight className={`w-5 h-5 transition-transform ${isBatchMode ? 'rotate-90' : ''}`} />
              </div>
            </motion.button>

            {/* Batch Queue Display */}
            <AnimatePresence>
              {isBatchMode && batchQueue.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="bg-white rounded-3xl border border-neutral-100 p-4 space-y-3 shadow-sm">
                    <div className="flex items-center justify-between px-2">
                      <h4 className="text-xs font-bold text-neutral-400 uppercase tracking-wider">Cola de Envío</h4>
                      <button 
                        onClick={processBatch}
                        disabled={loading}
                        className="flex items-center gap-1 text-xs font-bold text-emerald-600 hover:text-emerald-700 disabled:opacity-50"
                      >
                        <Send className="w-3 h-3" />
                        Enviar Todo
                      </button>
                    </div>
                    <div className="max-h-48 overflow-y-auto space-y-2 pr-1">
                      {batchQueue.map((item) => (
                        <div key={item.id} className="flex items-center justify-between p-3 bg-neutral-50 rounded-2xl">
                          <div className="flex items-center gap-3">
                            <div className={`p-1.5 rounded-lg ${getTypeColor(item.type)}`}>
                              {getTypeIcon(item.type)}
                            </div>
                            <div>
                              <span className="block text-xs font-bold capitalize">{item.type}</span>
                              <span className="text-[10px] text-neutral-400">{new Date(item.timestamp).toLocaleTimeString()}</span>
                            </div>
                          </div>
                          <button 
                            onClick={() => removeFromBatch(item.id)}
                            className="p-2 text-neutral-300 hover:text-red-500 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Selection Modal */}
            <AnimatePresence>
              {showSelection && (
                <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
                  <motion.div 
                    initial={{ y: "100%" }}
                    animate={{ y: 0 }}
                    exit={{ y: "100%" }}
                    className="bg-white w-full max-w-sm rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl"
                  >
                    <div className="flex justify-between items-center mb-6">
                      <h3 className="font-bold text-lg text-neutral-800">Seleccionar Origen</h3>
                      <button onClick={() => setShowSelection(null)} className="text-neutral-400 hover:text-neutral-600">
                        <AlertCircle className="w-6 h-6 rotate-45" />
                      </button>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <button 
                        onClick={() => {
                          const isAudio = showSelection.type === 'audio';
                          triggerFileSelect(showSelection.type as any, showSelection.accept, isAudio ? 'microphone' : 'environment');
                          setShowSelection(null);
                        }}
                        className="flex flex-col items-center gap-3 p-6 bg-neutral-50 rounded-2xl hover:bg-neutral-100 transition-colors"
                      >
                        <div className="p-3 bg-white rounded-xl shadow-sm">
                          {showSelection.type === 'audio' ? <Mic className="w-6 h-6 text-orange-500" /> : <Camera className="w-6 h-6 text-blue-500" />}
                        </div>
                        <span className="text-sm font-bold text-neutral-700">{showSelection.type === 'audio' ? 'Grabadora' : 'Cámara'}</span>
                      </button>
                      
                      <button 
                        onClick={() => {
                          triggerFileSelect(showSelection.type as any, showSelection.accept);
                          setShowSelection(null);
                        }}
                        className="flex flex-col items-center gap-3 p-6 bg-neutral-50 rounded-2xl hover:bg-neutral-100 transition-colors"
                      >
                        <div className="p-3 bg-white rounded-xl shadow-sm">
                          <ImageIcon className="w-6 h-6 text-emerald-500" />
                        </div>
                        <span className="text-sm font-bold text-neutral-700">Galería</span>
                      </button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>

            {/* Hidden File Input */}
            <input 
              type="file" 
              ref={fileInputRef}
              onChange={processFile}
              className="hidden"
            />

            {/* Results Area */}
            <AnimatePresence mode="wait">
              {loading && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="bg-white rounded-3xl p-12 flex flex-col items-center justify-center shadow-sm border border-neutral-100"
                >
                  <Loader2 className="w-12 h-12 text-emerald-500 animate-spin mb-4" />
                  <p className="text-neutral-600 font-medium">Analizando información...</p>
                  <p className="text-neutral-400 text-xs mt-1">Esto puede tardar unos segundos</p>
                </motion.div>
              )}

              {lastResult && !loading && (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-white rounded-3xl p-6 shadow-sm border border-neutral-100"
                >
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-bold text-neutral-900 flex items-center gap-2">
                      <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                      Resultado del Análisis
                    </h3>
                    <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 bg-neutral-100 px-2 py-1 rounded">JSON</span>
                  </div>
                  
                  <div className="space-y-3">
                    {Object.entries(lastResult).map(([key, value]) => (
                      <div key={key} className="flex flex-col border-b border-neutral-50 pb-2 last:border-0">
                        <span className="text-[10px] font-bold text-neutral-400 uppercase">{key.replace(/_/g, ' ')}</span>
                        <span className="text-neutral-800 font-medium">
                          {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}

              {error && !loading && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="bg-red-50 text-red-600 p-4 rounded-2xl flex items-center gap-3"
                >
                  <AlertCircle className="w-5 h-5" />
                  <p className="text-sm font-medium">{error}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ) : (
          <div className="space-y-4">
            <h3 className="font-bold text-neutral-900 mb-4">Historial Reciente</h3>
            {records.length === 0 ? (
              <div className="text-center py-12 text-neutral-400">
                <History className="w-12 h-12 mx-auto mb-2 opacity-20" />
                <p>No hay registros aún</p>
              </div>
            ) : (
              records.map((record) => (
                <div key={record.id} className="bg-white p-4 rounded-2xl border border-neutral-100 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`p-1.5 rounded-lg ${getTypeColor(record.type)}`}>
                        {getTypeIcon(record.type)}
                      </span>
                      <span className="font-bold text-sm capitalize">{record.type}</span>
                    </div>
                    <span className="text-[10px] text-neutral-400">{new Date(record.timestamp).toLocaleString()}</span>
                  </div>
                  <div className="text-xs text-neutral-600 bg-neutral-50 p-2 rounded-lg overflow-hidden text-ellipsis">
                    {JSON.stringify(record.data).substring(0, 100)}...
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </main>

      {/* Bottom Nav */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-neutral-200 px-8 py-4 flex justify-around items-center z-10">
        <button 
          onClick={() => setActiveTab('dashboard')}
          className={`flex flex-col items-center gap-1 transition-colors ${activeTab === 'dashboard' ? 'text-emerald-600' : 'text-neutral-400'}`}
        >
          <div className={`p-1 rounded-lg ${activeTab === 'dashboard' ? 'bg-emerald-50' : ''}`}>
            <ImageIcon className="w-6 h-6" />
          </div>
          <span className="text-[10px] font-bold">INICIO</span>
        </button>
        <button 
          onClick={() => setActiveTab('history')}
          className={`flex flex-col items-center gap-1 transition-colors ${activeTab === 'history' ? 'text-emerald-600' : 'text-neutral-400'}`}
        >
          <div className={`p-1 rounded-lg ${activeTab === 'history' ? 'bg-emerald-50' : ''}`}>
            <History className="w-6 h-6" />
          </div>
          <span className="text-[10px] font-bold">HISTORIAL</span>
        </button>
      </nav>
    </div>
  );
}

function ActionButton({ icon, label, color, onClick }: { icon: React.ReactNode, label: string, color: string, onClick: () => void }) {
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      onClick={onClick}
      className="flex flex-col items-center justify-center aspect-square bg-white rounded-3xl shadow-sm border border-neutral-100 p-4 hover:shadow-md transition-all"
    >
      <div className={`p-4 rounded-2xl mb-3 ${color}`}>
        {icon}
      </div>
      <span className="text-xs font-bold text-neutral-700 text-center leading-tight">{label}</span>
    </motion.button>
  );
}

function getTypeIcon(type: string) {
  switch (type) {
    case 'sensor': return <Camera className="w-4 h-4" />;
    case 'sheet': return <FileText className="w-4 h-4" />;
    case 'audio': return <Mic className="w-4 h-4" />;
    case 'document': return <FileUp className="w-4 h-4" />;
    default: return <FileText className="w-4 h-4" />;
  }
}

function getTypeColor(type: string) {
  switch (type) {
    case 'sensor': return 'bg-blue-50 text-blue-600';
    case 'sheet': return 'bg-purple-50 text-purple-600';
    case 'audio': return 'bg-orange-50 text-orange-600';
    case 'document': return 'bg-emerald-50 text-emerald-600';
    default: return 'bg-neutral-50 text-neutral-600';
  }
}


import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, Type, LiveServerMessage } from '@google/genai';
import { PACKAGES, AHMED_SYSTEM_INSTRUCTION } from './constants';
import { CallStatus, AppointmentData } from './types';
import { decode, encode, decodeAudioData, createBlob } from './utils/audio-utils';

const App: React.FC = () => {
  const [status, setStatus] = useState<CallStatus>(CallStatus.IDLE);
  const [appointment, setAppointment] = useState<AppointmentData | null>(null);
  const [transcription, setTranscription] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Audio Contexts
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopCall = useCallback(() => {
    if (sessionRef.current) {
      // Logic to close session if SDK supported it explicitly, 
      // otherwise we just stop our local resources.
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close();
      inputAudioCtxRef.current = null;
    }
    // We keep output ctx for now or close it
    setStatus(CallStatus.IDLE);
    setTranscription('');
  }, []);

  const startCall = async () => {
    try {
      setStatus(CallStatus.CONNECTING);
      setError(null);

      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });

      // Initialize Audio
      inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const bookAppointmentTool = {
        name: 'bookAppointment',
        parameters: {
          type: Type.OBJECT,
          description: 'Saves dental appointment details captured from the conversation.',
          properties: {
            patientName: { type: Type.STRING },
            phone: { type: Type.STRING },
            packageType: { type: Type.STRING },
            date: { type: Type.STRING },
            time: { type: Type.STRING },
            medicalConditions: { type: Type.STRING }
          },
          required: ['patientName', 'phone', 'packageType', 'date', 'time']
        }
      };

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          systemInstruction: AHMED_SYSTEM_INSTRUCTION,
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } // Warm male voice
          },
          tools: [{ functionDeclarations: [bookAppointmentTool] }],
          outputAudioTranscription: {},
          inputAudioTranscription: {}
        },
        callbacks: {
          onopen: () => {
            console.log('Ahmed is online');
            setStatus(CallStatus.ACTIVE);

            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);

            scriptProcessor.onaudioprocess = (e) => {
              if (status === CallStatus.ACTIVE || true) { // Using true because state might be stale in closure
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmBlob = createBlob(inputData);
                sessionPromise.then(session => {
                  session.sendRealtimeInput({ media: pcmBlob });
                });
              }
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current!.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            // Handle Audio
            const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && outputAudioCtxRef.current) {
              const ctx = outputAudioCtxRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.addEventListener('ended', () => sourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }

            // Handle Interruption
            if (msg.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            // Handle Transcriptions
            if (msg.serverContent?.outputTranscription) {
              setTranscription(prev => prev + " " + msg.serverContent!.outputTranscription!.text);
            }

            // Handle Tool Calls (Appointment Booking)
            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'bookAppointment') {
                  const data = fc.args as AppointmentData;
                  setAppointment(data);
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: { id: fc.id, name: fc.name, response: { result: "success" } }
                  }));
                }
              }
            }
          },
          onerror: (e) => {
            console.error('Gemini Live Error:', e);
            setError("حدث خطأ في الاتصال. يرجى المحاولة مرة أخرى.");
            stopCall();
          },
          onclose: () => {
            console.log('Ahmed went offline');
            stopCall();
          }
        }
      });

      sessionRef.current = sessionPromise;

    } catch (err) {
      console.error(err);
      setError("تعذر الوصول إلى الميكروفون أو بدء الجلسة.");
      setStatus(CallStatus.IDLE);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 overflow-x-hidden">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-xl text-white shadow-lg shadow-blue-200">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4c-4.418 0-8 3.582-8 8s3.582 8 8 8 8-3.582 8-8-3.582-8-8-8zm0 14c-3.314 0-6-2.686-6-6s2.686-6 6-6 6 2.686 6 6-2.686 6-6 6z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-slate-800 tracking-tight">عيادة الابتسامة المشرقة</h1>
          </div>
          <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
            متاح الآن
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-8">

        {/* Status Indicator */}
        <div className="mb-8 text-center">
          {status === CallStatus.IDLE && (
            <div className="p-8 bg-blue-50 rounded-3xl border border-blue-100 mb-6">
              <h2 className="text-2xl font-bold text-blue-900 mb-4">تحدث مع أحمد - مساعدك الشخصي</h2>
              <p className="text-blue-700 leading-relaxed max-w-md mx-auto">
                يسعدنا خدمتك! اضغط على الزر أدناه للتحدث مع أحمد لحجز موعد أو الاستفسار عن خدماتنا بلهجة سعودية محببة.
              </p>
            </div>
          )}

          <div className="relative inline-block">
            {status === CallStatus.ACTIVE && (
              <div className="absolute -inset-4 bg-blue-500/20 rounded-full animate-ping opacity-75"></div>
            )}
            <button
              onClick={status === CallStatus.IDLE ? startCall : stopCall}
              disabled={status === CallStatus.CONNECTING}
              className={`relative z-10 w-24 h-24 rounded-full flex items-center justify-center shadow-2xl transition-all duration-300 transform active:scale-90 ${status === CallStatus.IDLE ? 'bg-blue-600 hover:bg-blue-700' :
                  status === CallStatus.ACTIVE ? 'bg-red-500 hover:bg-red-600' : 'bg-slate-400'
                }`}
            >
              {status === CallStatus.IDLE ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              ) : status === CallStatus.CONNECTING ? (
                <svg className="animate-spin h-8 w-8 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              )}
            </button>
          </div>
          <p className="mt-4 font-bold text-slate-600">
            {status === CallStatus.IDLE ? "ابدأ المحادثة" : status === CallStatus.ACTIVE ? "أحمد يستمع إليك..." : "جارٍ الاتصال..."}
          </p>
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-xl mb-6 text-center">
            {error}
          </div>
        )}

        {/* Live Transcript (Hidden normally, but good for debug/accessibility) */}
        {transcription && status === CallStatus.ACTIVE && (
          <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 mb-8 italic text-slate-500 text-center animate-pulse">
            "{transcription.slice(-100)}..."
          </div>
        )}

        {/* Captured Appointment Card */}
        {appointment && (
          <div className="bg-green-50 border border-green-200 rounded-3xl p-6 mb-8 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="bg-green-500 p-2 rounded-full text-white">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              </div>
              <h3 className="text-xl font-bold text-green-900">تم حجز موعدك بنجاح!</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-green-800">
              <div className="bg-white/50 p-3 rounded-xl"><span className="font-bold">المريض:</span> {appointment.patientName}</div>
              <div className="bg-white/50 p-3 rounded-xl"><span className="font-bold">الجوال:</span> {appointment.phone}</div>
              <div className="bg-white/50 p-3 rounded-xl"><span className="font-bold">الباقة:</span> {appointment.packageType}</div>
              <div className="bg-white/50 p-3 rounded-xl"><span className="font-bold">الموعد:</span> {appointment.date} في {appointment.time}</div>
              {appointment.medicalConditions && (
                <div className="bg-white/50 p-3 rounded-xl col-span-full"><span className="font-bold">ملاحظات طبية:</span> {appointment.medicalConditions}</div>
              )}
            </div>
            <p className="mt-4 text-sm text-green-700 font-medium">سيتم إرسال تأكيد الموعد عبر الواتساب قريباً.</p>
          </div>
        )}

        {/* Packages Grid */}
        <section>
          <h3 className="text-2xl font-bold text-slate-800 mb-6 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            باقاتنا العلاجية المتميزة
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {PACKAGES.map((pkg) => (
              <div key={pkg.id} className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-shadow group">
                <div className="flex justify-between items-start mb-4">
                  <h4 className="text-lg font-bold text-slate-800 group-hover:text-blue-600 transition-colors">{pkg.name}</h4>
                  <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-sm font-bold whitespace-nowrap">{pkg.price}</span>
                </div>
                <div className="flex items-center gap-2 text-slate-400 text-sm mb-4">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {pkg.duration}
                </div>
                <ul className="space-y-2 mb-4">
                  {pkg.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-2 text-slate-600 text-sm">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-green-500 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                      </svg>
                      {feature}
                    </li>
                  ))}
                </ul>
                <div className="pt-4 border-t border-slate-50">
                  <p className="text-xs text-slate-400 font-medium italic">مثالية لـ: {pkg.idealFor}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Info Cards */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-12">
          <div className="bg-white p-5 rounded-2xl text-center border border-slate-100">
            <div className="w-10 h-10 bg-orange-100 text-orange-600 rounded-xl flex items-center justify-center mx-auto mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <h5 className="font-bold text-slate-800 text-sm">موقعنا</h5>
            <p className="text-xs text-slate-500">حي النخيل، شارع العليا، الرياض</p>
          </div>
          <div className="bg-white p-5 rounded-2xl text-center border border-slate-100">
            <div className="w-10 h-10 bg-purple-100 text-purple-600 rounded-xl flex items-center justify-center mx-auto mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h5 className="font-bold text-slate-800 text-sm">ساعات العمل</h5>
            <p className="text-xs text-slate-500">السبت - الخميس: 9ص - 10م</p>
          </div>
          <div className="bg-white p-5 rounded-2xl text-center border border-slate-100">
            <div className="w-10 h-10 bg-red-100 text-red-600 rounded-xl flex items-center justify-center mx-auto mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            </div>
            <h5 className="font-bold text-slate-800 text-sm">الطوارئ</h5>
            <p className="text-xs text-slate-500">خدمة 24/7 للحالات العاجلة</p>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-slate-100 py-6 text-center text-slate-500 text-sm mt-12">
        <p>© 2024 عيادة الابتسامة المشرقة لطب الأسنان - الرياض</p>
        <p className="mt-1">جميع الحقوق محفوظة. معتمدين من وزارة الصحة السعودية.</p>
      </footer>
    </div>
  );
};

export default App;

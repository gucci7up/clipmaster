import { Scissors } from 'lucide-react';
import Link from 'next/link';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-violet-700 via-indigo-700 to-fuchsia-700 p-10 text-white lg:flex lg:flex-col">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold">
          <span className="grid size-9 place-items-center rounded-lg bg-white/15"><Scissors className="size-5" /></span>
          ClipMaster AI
        </Link>
        <div className="mt-auto max-w-md space-y-4">
          <h2 className="text-3xl font-bold leading-tight">Convierte horas de video en clips listos para redes.</h2>
          <p className="text-white/80">
            Transcripción, análisis de audio y video, detección de momentos y subtítulos automáticos — procesados en tu propio servidor.
          </p>
        </div>
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-white/10 blur-3xl" />
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}

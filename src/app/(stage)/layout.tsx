import { RIP_LAYERS } from "@/lib/rip-art";

export default function StageLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="preload" as="image" href="/assets/stage-pack.webp" />
      {RIP_LAYERS.map((src) => (
        <link key={src} rel="preload" as="image" href={src} />
      ))}
      {children}
    </>
  );
}

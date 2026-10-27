import Image from "next/image";

export default function Card({ src }: { src: string }) {
  return <Image src={src} width={160} height={160} sizes="33vw" alt="" />;
}

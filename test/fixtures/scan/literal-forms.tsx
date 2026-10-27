import Image from "next/image";

export function Forms() {
  return (
    <>
      <Image src={"/a.png"} sizes={'33vw'} quality={85} fill={true} />
      <Image src={`/b.png`} sizes={`10vw`} width={{ ok: 1 }} height={false} />
    </>
  );
}

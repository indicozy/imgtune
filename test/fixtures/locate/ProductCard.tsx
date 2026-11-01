import Image from "next/image";

export function ProductCard({ product }: Props) {
  return (
    <a href={product.url}>
      <Image
        className="w-full"
        src={product.image}
        alt={product.name}
        sizes="33vw"
        width={160}
        height={160}
      />
    </a>
  );
}

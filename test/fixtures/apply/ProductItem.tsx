import Image from 'next/image';

type Product = { name: string };
type Props = { product: Product; imageUrl?: string; priority?: boolean };

function generateAltTag(product: Product): string {
  return product.name;
}

export function ProductItem({ product, imageUrl, priority }: Props) {
  return (
    <div>
            <div className='relative'>
              <Image
                className='w-full aspect-square object-cover grow-0 shrink'
                src={imageUrl?.trim()}
                alt={generateAltTag(product)}
                sizes='33vw'
                width={160}
                height={160}
                priority={priority}
                fetchPriority={priority ? 'high' : 'auto'}
                loading={priority ? 'eager' : 'lazy'}
              />
            </div>
    </div>
  );
}

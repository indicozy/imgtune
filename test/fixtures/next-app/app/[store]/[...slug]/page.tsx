import Card from "@/components/Card";

const CARD_COUNT = 8;

export default async function Page({
  params,
}: {
  params: Promise<{ store: string; slug: string[] }>;
}) {
  const { store, slug } = await params;
  const indexes = Array.from({ length: CARD_COUNT }, (_, i) => i + 1);

  return (
    <main>
      <h1>
        {store} / {slug.join("/")}
      </h1>
      <ul className="grid">
        {indexes.map((i) => (
          <li key={i}>
            <Card src={`/img/p${i}.jpg`} />
          </li>
        ))}
      </ul>
    </main>
  );
}

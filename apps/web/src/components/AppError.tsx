export function AppError() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-6">
      <p className="text-body-s">Something went wrong.</p>
      <button type="button" className="button button-primary" onClick={() => location.reload()}>
        Reload
      </button>
    </main>
  );
}

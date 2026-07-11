export function WaveAnimation() {
  return (
    <div className="flex items-center justify-center gap-1 h-8">
      {[0, 1, 2, 3, 4].map(i => (
        <div
          key={i}
          className="w-1 bg-red-400 rounded-full"
          style={{
            animation: `wave 0.8s ease-in-out ${i * 0.1}s infinite`,
            height: '8px',
          }}
        />
      ))}
    </div>
  )
}

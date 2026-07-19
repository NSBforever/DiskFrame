import React from 'react'

interface MediaViewerToolbarProps {
  fileName: string
  filePath: string
  isFav: boolean
  onFav: () => void
  onReveal: () => void
  onClose: () => void
  onRotateLeft: () => void
  onRotateRight: () => void
  onFlip: () => void
  scale: number
  onZoomChange: (newScale: number) => void
  onFitWidth: () => void
  onFitHeight: () => void
  onActualSize: () => void
  onDownload: () => void
  onCopyPath: () => void
  onDelete: () => void
  onToggleInfo: () => void
  isInfoOpen: boolean
}

const IconBtn: React.FC<{
  onClick: (e: React.MouseEvent) => void
  title?: string
  children: React.ReactNode
  active?: boolean
}> = ({ onClick, title, children, active }) => (
  <button
    onClick={onClick}
    title={title}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '36px',
      height: '36px',
      borderRadius: '8px',
      border: 'none',
      cursor: 'pointer',
      background: active ? 'rgba(108,108,255,0.25)' : 'transparent',
      color: active ? '#a0a0ff' : '#d0d0e0',
      fontSize: '15px',
      transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
      flexShrink: 0
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.background = active ? 'rgba(108,108,255,0.35)' : 'rgba(255,255,255,0.08)'
      e.currentTarget.style.transform = 'scale(1.05)'
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.background = active ? 'rgba(108,108,255,0.25)' : 'transparent'
      e.currentTarget.style.transform = 'scale(1)'
    }}
  >
    {children}
  </button>
)

export const MediaViewerToolbar: React.FC<MediaViewerToolbarProps> = ({
  fileName,
  isFav,
  onFav,
  onReveal,
  onClose,
  onRotateLeft,
  onRotateRight,
  onFlip,
  scale,
  onZoomChange,
  onFitWidth,
  onFitHeight,
  onActualSize,
  onDownload,
  onCopyPath,
  onDelete,
  onToggleInfo,
  isInfoOpen
}) => {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: 'rgba(15,15,22,0.85)',
        backdropFilter: 'blur(20px) saturate(1.4)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '16px',
        padding: '6px 12px',
        zIndex: 1000,
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        maxWidth: 'calc(100vw - 40px)',
        minWidth: '680px',
        justifyContent: 'space-between',
        userSelect: 'none'
      }}
    >
      {/* File name */}
      <div
        style={{
          fontSize: '12px',
          fontWeight: 500,
          color: '#b0b0c8',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: '180px',
          padding: '0 6px'
        }}
        title={fileName}
      >
        {fileName}
      </div>

      <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />

      {/* Zoom Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <IconBtn onClick={() => onZoomChange(scale - 0.5)} title="Zoom Out ( - )">
          －
        </IconBtn>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <input
            type="range"
            min="100"
            max="800"
            value={Math.round(scale * 100)}
            onChange={(e) => onZoomChange(Number(e.target.value) / 100)}
            style={{
              width: '80px',
              height: '3px',
              background: '#2a2a3a',
              outline: 'none',
              cursor: 'pointer'
            }}
          />
          <div style={{ fontSize: '9px', color: '#7070a0', marginTop: '2px', minWidth: '32px', textAlign: 'center' }}>
            {Math.round(scale * 100)}%
          </div>
        </div>
        <IconBtn onClick={() => onZoomChange(scale + 0.5)} title="Zoom In ( + )">
          ＋
        </IconBtn>

        {/* Zoom Presets */}
        <IconBtn onClick={onFitWidth} title="Fit Width">
          ↔
        </IconBtn>
        <IconBtn onClick={onFitHeight} title="Fit Height">
          ↕
        </IconBtn>
        <IconBtn onClick={onActualSize} title="Actual Size (1:1 / 0)">
          1:1
        </IconBtn>
      </div>

      <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />

      {/* Transform Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
        <IconBtn onClick={onRotateLeft} title="Rotate Left">
          ↺
        </IconBtn>
        <IconBtn onClick={onRotateRight} title="Rotate Right">
          ↻
        </IconBtn>
        <IconBtn onClick={onFlip} title="Flip Horizontal">
          ⇄
        </IconBtn>
      </div>

      <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />

      {/* Utility Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
        <IconBtn onClick={onFav} title={isFav ? 'Remove from Favourites' : 'Add to Favourites'} active={isFav}>
          {isFav ? '❤️' : '🤍'}
        </IconBtn>
        <IconBtn onClick={onDownload} title="Download File">
          📥
        </IconBtn>
        <IconBtn onClick={onReveal} title="Show in Folder">
          📁
        </IconBtn>
        <IconBtn onClick={onCopyPath} title="Copy Absolute Path">
          📋
        </IconBtn>
        <IconBtn onClick={onToggleInfo} title="Toggle Info (EXIF)" active={isInfoOpen}>
          ℹ️
        </IconBtn>
        <IconBtn onClick={() => {}} title="Share (Coming Soon)">
          📤
        </IconBtn>
        <IconBtn onClick={onDelete} title="Delete File">
          🗑️
        </IconBtn>
      </div>

      <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />

      {/* Close button */}
      <IconBtn onClick={onClose} title="Close Viewer (Esc)">
        ✕
      </IconBtn>
    </div>
  )
}
export default MediaViewerToolbar

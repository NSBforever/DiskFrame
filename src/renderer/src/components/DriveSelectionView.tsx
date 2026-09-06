import DriveSelectGrid, { Drive } from './DriveSelectGrid'

export interface DriveInfo {
  name: string
  filesystem: string
  total: number
  used: number
  free: number
}

interface DriveSelectionViewProps {
  drives: DriveInfo[]
  onDriveSelect: (driveName: string) => void
  driveFiles?: Record<string, Record<string, any[]>>
}

export function DriveSelectionView({
  drives,
  onDriveSelect,
  driveFiles
}: DriveSelectionViewProps) {
  const handleSelectDrive = (drive: Drive) => {
    onDriveSelect(drive.letter)
  }

  return (
    <div
      className="view-transition-enter"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100%',
        width: '100%',
        padding: '20px 0',
        boxSizing: 'border-box'
      }}
    >
      <DriveSelectGrid
        onSelectDrive={handleSelectDrive}
        drives={drives}
        driveFiles={driveFiles}
      />
    </div>
  )
}

export default DriveSelectionView

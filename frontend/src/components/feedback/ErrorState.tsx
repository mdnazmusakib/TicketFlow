import { Button } from '../ui/Button';

interface Props {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function ErrorState({ title, message, actionLabel, onAction }: Props) {
  return (
    <div className="error-state" role="alert">
      <h1>{title}</h1>
      <p>{message}</p>
      {actionLabel && onAction && <Button onClick={onAction}>{actionLabel}</Button>}
    </div>
  );
}

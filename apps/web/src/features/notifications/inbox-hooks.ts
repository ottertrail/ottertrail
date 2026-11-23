import { useMutation, useQueryClient } from "@tanstack/react-query";

import { markAllNotificationsRead, markNotification, refreshInbox } from "@/lib/notifications-api";

export function useMarkNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, read }: { id: string; read: boolean }) => markNotification(id, read),
    onSettled: () => refreshInbox(queryClient),
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: markAllNotificationsRead,
    onSettled: () => refreshInbox(queryClient),
  });
}

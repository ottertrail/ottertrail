import { useMutation, useQueryClient } from "@tanstack/react-query";

import { markAllNotificationsRead, markNotification, refreshInbox } from "@/lib/notifications-api";

/** Marks an item read or unread, then reads the count and the lists again. */
export function useMarkNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, read }: { id: string; read: boolean }) => markNotification(id, read),
    onSettled: () => refreshInbox(queryClient),
  });
}

/** Marks every item read; the count and lists are read again. */
export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: markAllNotificationsRead,
    onSettled: () => refreshInbox(queryClient),
  });
}

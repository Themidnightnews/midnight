export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      admin_accounts: {
        Row: {
          created_at: string
          disabled: boolean
          email: string
          id: string
          last_login_at: string | null
          password_hash: string
          role: string
          username: string
        }
        Insert: {
          created_at?: string
          disabled?: boolean
          email: string
          id?: string
          last_login_at?: string | null
          password_hash: string
          role?: string
          username: string
        }
        Update: {
          created_at?: string
          disabled?: boolean
          email?: string
          id?: string
          last_login_at?: string | null
          password_hash?: string
          role?: string
          username?: string
        }
        Relationships: []
      }
      admin_audit_log: {
        Row: {
          account_id: string | null
          action: string
          created_at: string
          detail: Json
          id: string
          ip_hash: string | null
          username: string | null
        }
        Insert: {
          account_id?: string | null
          action: string
          created_at?: string
          detail?: Json
          id?: string
          ip_hash?: string | null
          username?: string | null
        }
        Update: {
          account_id?: string | null
          action?: string
          created_at?: string
          detail?: Json
          id?: string
          ip_hash?: string | null
          username?: string | null
        }
        Relationships: []
      }
      admin_sessions: {
        Row: {
          account_id: string
          created_at: string
          expires_at: string
          id: string
          ip_hash: string | null
          last_seen_at: string
          revoked_at: string | null
          token_hash: string
          user_agent: string | null
        }
        Insert: {
          account_id: string
          created_at?: string
          expires_at: string
          id?: string
          ip_hash?: string | null
          last_seen_at?: string
          revoked_at?: string | null
          token_hash: string
          user_agent?: string | null
        }
        Update: {
          account_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          ip_hash?: string | null
          last_seen_at?: string
          revoked_at?: string | null
          token_hash?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_sessions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "admin_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      page_views: {
        Row: {
          article_slug: string | null
          created_at: string
          device: string | null
          id: string
          path: string
          referrer: string | null
          visitor_id: string
        }
        Insert: {
          article_slug?: string | null
          created_at?: string
          device?: string | null
          id?: string
          path: string
          referrer?: string | null
          visitor_id: string
        }
        Update: {
          article_slug?: string | null
          created_at?: string
          device?: string | null
          id?: string
          path?: string
          referrer?: string | null
          visitor_id?: string
        }
        Relationships: []
      }
      signup_attempts: {
        Row: {
          created_at: string
          id: string
          ip_hash: string
        }
        Insert: {
          created_at?: string
          id?: string
          ip_hash: string
        }
        Update: {
          created_at?: string
          id?: string
          ip_hash?: string
        }
        Relationships: []
      }
      site_settings: {
        Row: {
          comments_enabled: boolean
          id: number
          maintenance_message: string
          maintenance_mode: boolean
          signups_enabled: boolean
          updated_at: string
        }
        Insert: {
          comments_enabled?: boolean
          id?: number
          maintenance_message?: string
          maintenance_mode?: boolean
          signups_enabled?: boolean
          updated_at?: string
        }
        Update: {
          comments_enabled?: boolean
          id?: number
          maintenance_message?: string
          maintenance_mode?: boolean
          signups_enabled?: boolean
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      account_login_status: { Args: { _email: string }; Returns: string }
      admin_check_password: {
        Args: { _login: string; _password: string }
        Returns: string
      }
      admin_hash_password: { Args: { _password: string }; Returns: string }
      admin_view_stats: {
        Args: { _days: number; _slug?: string }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

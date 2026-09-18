export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
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
  public: {
    Tables: {
      access_denials: {
        Row: {
          actor_id: string | null
          facility_id: string | null
          guard: string
          id: string
          method: string | null
          occurred_at: string
          reason: string
          route: string | null
        }
        Insert: {
          actor_id?: string | null
          facility_id?: string | null
          guard: string
          id?: string
          method?: string | null
          occurred_at?: string
          reason: string
          route?: string | null
        }
        Update: {
          actor_id?: string | null
          facility_id?: string | null
          guard?: string
          id?: string
          method?: string | null
          occurred_at?: string
          reason?: string
          route?: string | null
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_role: string
          changed_columns: string[] | null
          facility_id: string | null
          id: string
          new_data: Json | null
          occurred_at: string
          old_data: Json | null
          row_id: string | null
          table_name: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_role: string
          changed_columns?: string[] | null
          facility_id?: string | null
          id?: string
          new_data?: Json | null
          occurred_at?: string
          old_data?: Json | null
          row_id?: string | null
          table_name: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_role?: string
          changed_columns?: string[] | null
          facility_id?: string | null
          id?: string
          new_data?: Json | null
          occurred_at?: string
          old_data?: Json | null
          row_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      case_order_items: {
        Row: {
          case_order_id: string
          created_at: string
          id: string
          jan: string
          lot: string | null
          quantity: number
          ubd: string | null
          unit_price: number | null
          updated_at: string
        }
        Insert: {
          case_order_id: string
          created_at?: string
          id?: string
          jan: string
          lot?: string | null
          quantity?: number
          ubd?: string | null
          unit_price?: number | null
          updated_at?: string
        }
        Update: {
          case_order_id?: string
          created_at?: string
          id?: string
          jan?: string
          lot?: string | null
          quantity?: number
          ubd?: string | null
          unit_price?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_order_items_case_order_id_fkey"
            columns: ["case_order_id"]
            isOneToOne: false
            referencedRelation: "case_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "case_order_items_jan_fkey"
            columns: ["jan"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["jan"]
          },
        ]
      }
      case_orders: {
        Row: {
          case_datetime: string
          client_request_id: string | null
          created_at: string
          doctor_name: string
          facility_id: string
          gender: string
          id: string
          patient_id: string
          patient_initials: string
          procedure_name: string
          status: string
          updated_at: string
        }
        Insert: {
          case_datetime: string
          client_request_id?: string | null
          created_at?: string
          doctor_name: string
          facility_id: string
          gender: string
          id?: string
          patient_id: string
          patient_initials: string
          procedure_name: string
          status?: string
          updated_at?: string
        }
        Update: {
          case_datetime?: string
          client_request_id?: string | null
          created_at?: string
          doctor_name?: string
          facility_id?: string
          gender?: string
          id?: string
          patient_id?: string
          patient_initials?: string
          procedure_name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_orders_facility_id_fkey"
            columns: ["facility_id"]
            isOneToOne: false
            referencedRelation: "facilities"
            referencedColumns: ["id"]
          },
        ]
      }
      categories: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      consumable_order_items: {
        Row: {
          consumable_id: string
          consumable_order_id: string
          created_at: string
          id: string
          quantity: number
          unit_price: number | null
        }
        Insert: {
          consumable_id: string
          consumable_order_id: string
          created_at?: string
          id?: string
          quantity?: number
          unit_price?: number | null
        }
        Update: {
          consumable_id?: string
          consumable_order_id?: string
          created_at?: string
          id?: string
          quantity?: number
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "consumable_order_items_consumable_id_fkey"
            columns: ["consumable_id"]
            isOneToOne: false
            referencedRelation: "consumables"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumable_order_items_consumable_order_id_fkey"
            columns: ["consumable_order_id"]
            isOneToOne: false
            referencedRelation: "consumable_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      consumable_orders: {
        Row: {
          client_request_id: string | null
          created_at: string
          facility_id: string
          id: string
          status: string
          updated_at: string
        }
        Insert: {
          client_request_id?: string | null
          created_at?: string
          facility_id: string
          id?: string
          status?: string
          updated_at?: string
        }
        Update: {
          client_request_id?: string | null
          created_at?: string
          facility_id?: string
          id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "consumable_orders_facility_id_fkey"
            columns: ["facility_id"]
            isOneToOne: false
            referencedRelation: "facilities"
            referencedColumns: ["id"]
          },
        ]
      }
      consumables: {
        Row: {
          created_at: string
          facility_id: string
          id: string
          jan: string | null
          name: string
          purpose: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          facility_id: string
          id?: string
          jan?: string | null
          name: string
          purpose: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          facility_id?: string
          id?: string
          jan?: string | null
          name?: string
          purpose?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "consumables_facility_id_fkey"
            columns: ["facility_id"]
            isOneToOne: false
            referencedRelation: "facilities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumables_jan_fkey"
            columns: ["jan"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["jan"]
          },
        ]
      }
      distributor_products: {
        Row: {
          category_id: string
          created_at: string
          id: string
          maker: string
          name: string
          product_id: string
          quantity: number
          reimbursement_price: number | null
          supplier: string
          updated_at: string
        }
        Insert: {
          category_id: string
          created_at?: string
          id?: string
          maker: string
          name: string
          product_id: string
          quantity?: number
          reimbursement_price?: number | null
          supplier: string
          updated_at?: string
        }
        Update: {
          category_id?: string
          created_at?: string
          id?: string
          maker?: string
          name?: string
          product_id?: string
          quantity?: number
          reimbursement_price?: number | null
          supplier?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "distributor_products_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "distributor_products_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      facilities: {
        Row: {
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      hospital_prices: {
        Row: {
          created_at: string
          delivery_price: number
          delivery_rate: number | null
          distributor_product_id: string
          facility_id: string
          gross_profit: number
          id: string
          purchase_price: number
          purchase_rate: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          delivery_price: number
          delivery_rate?: number | null
          distributor_product_id: string
          facility_id: string
          gross_profit?: number
          id?: string
          purchase_price: number
          purchase_rate?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          delivery_price?: number
          delivery_rate?: number | null
          distributor_product_id?: string
          facility_id?: string
          gross_profit?: number
          id?: string
          purchase_price?: number
          purchase_rate?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hospital_prices_distributor_product_id_fkey"
            columns: ["distributor_product_id"]
            isOneToOne: false
            referencedRelation: "distributor_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hospital_prices_facility_id_fkey"
            columns: ["facility_id"]
            isOneToOne: false
            referencedRelation: "facilities"
            referencedColumns: ["id"]
          },
        ]
      }
      loan_order_items: {
        Row: {
          created_at: string
          id: string
          jan: string | null
          loan_order_id: string
          name: string
          quantity: number
          unit_price: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          jan?: string | null
          loan_order_id: string
          name: string
          quantity?: number
          unit_price?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          jan?: string | null
          loan_order_id?: string
          name?: string
          quantity?: number
          unit_price?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loan_order_items_jan_fkey"
            columns: ["jan"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["jan"]
          },
          {
            foreignKeyName: "loan_order_items_loan_order_id_fkey"
            columns: ["loan_order_id"]
            isOneToOne: false
            referencedRelation: "loan_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      loan_orders: {
        Row: {
          client_request_id: string | null
          created_at: string
          facility_id: string
          id: string
          maker: string
          procedure_name: string
          status: string
          updated_at: string
        }
        Insert: {
          client_request_id?: string | null
          created_at?: string
          facility_id: string
          id?: string
          maker: string
          procedure_name: string
          status?: string
          updated_at?: string
        }
        Update: {
          client_request_id?: string | null
          created_at?: string
          facility_id?: string
          id?: string
          maker?: string
          procedure_name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loan_orders_facility_id_fkey"
            columns: ["facility_id"]
            isOneToOne: false
            referencedRelation: "facilities"
            referencedColumns: ["id"]
          },
        ]
      }
      loan_return_items: {
        Row: {
          created_at: string
          id: string
          jan: string
          loan_order_item_id: string | null
          loan_return_id: string
          lot: string | null
          quantity: number
          status: string
          ubd: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          jan: string
          loan_order_item_id?: string | null
          loan_return_id: string
          lot?: string | null
          quantity?: number
          status?: string
          ubd?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          jan?: string
          loan_order_item_id?: string | null
          loan_return_id?: string
          lot?: string | null
          quantity?: number
          status?: string
          ubd?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loan_return_items_jan_fkey"
            columns: ["jan"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["jan"]
          },
          {
            foreignKeyName: "loan_return_items_loan_order_item_id_fkey"
            columns: ["loan_order_item_id"]
            isOneToOne: false
            referencedRelation: "loan_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_return_items_loan_return_id_fkey"
            columns: ["loan_return_id"]
            isOneToOne: false
            referencedRelation: "loan_returns"
            referencedColumns: ["id"]
          },
        ]
      }
      loan_returns: {
        Row: {
          client_request_id: string | null
          created_at: string
          facility_id: string
          id: string
          loan_order_id: string | null
          return_datetime: string
          status: string
          updated_at: string
        }
        Insert: {
          client_request_id?: string | null
          created_at?: string
          facility_id: string
          id?: string
          loan_order_id?: string | null
          return_datetime: string
          status?: string
          updated_at?: string
        }
        Update: {
          client_request_id?: string | null
          created_at?: string
          facility_id?: string
          id?: string
          loan_order_id?: string | null
          return_datetime?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loan_returns_facility_id_fkey"
            columns: ["facility_id"]
            isOneToOne: false
            referencedRelation: "facilities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_returns_loan_order_id_fkey"
            columns: ["loan_order_id"]
            isOneToOne: false
            referencedRelation: "loan_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      price_histories: {
        Row: {
          changed_at: string
          distributor_product_id: string
          entity_id: string
          entity_type: string
          field_name: string
          id: string
          new_value: number | null
          old_value: number | null
        }
        Insert: {
          changed_at?: string
          distributor_product_id: string
          entity_id: string
          entity_type: string
          field_name: string
          id?: string
          new_value?: number | null
          old_value?: number | null
        }
        Update: {
          changed_at?: string
          distributor_product_id?: string
          entity_id?: string
          entity_type?: string
          field_name?: string
          id?: string
          new_value?: number | null
          old_value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "price_histories_distributor_product_id_fkey"
            columns: ["distributor_product_id"]
            isOneToOne: false
            referencedRelation: "distributor_products"
            referencedColumns: ["id"]
          },
        ]
      }
      privileged_operations: {
        Row: {
          actor_id: string
          error_code: string | null
          id: string
          method: string | null
          occurred_at: string
          operation: string
          route: string | null
          succeeded: boolean
          target_email: string | null
          target_user_id: string | null
        }
        Insert: {
          actor_id: string
          error_code?: string | null
          id?: string
          method?: string | null
          occurred_at?: string
          operation: string
          route?: string | null
          succeeded: boolean
          target_email?: string | null
          target_user_id?: string | null
        }
        Update: {
          actor_id?: string
          error_code?: string | null
          id?: string
          method?: string | null
          occurred_at?: string
          operation?: string
          route?: string | null
          succeeded?: boolean
          target_email?: string | null
          target_user_id?: string | null
        }
        Relationships: []
      }
      product_compatibilities: {
        Row: {
          category_id: string
          created_at: string
          id: string
          note: string | null
          product_id_1: string
          product_id_2: string
          updated_at: string
        }
        Insert: {
          category_id: string
          created_at?: string
          id?: string
          note?: string | null
          product_id_1: string
          product_id_2: string
          updated_at?: string
        }
        Update: {
          category_id?: string
          created_at?: string
          id?: string
          note?: string | null
          product_id_1?: string
          product_id_2?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_compatibilities_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_compatibilities_product_id_1_fkey"
            columns: ["product_id_1"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_compatibilities_product_id_2_fkey"
            columns: ["product_id_2"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          created_at: string
          id: string
          jan: string
          maker: string | null
          name: string
          ref: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          jan: string
          maker?: string | null
          name?: string
          ref: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          jan?: string
          maker?: string | null
          name?: string
          ref?: string
          updated_at?: string
        }
        Relationships: []
      }
      rate_limit_counters: {
        Row: {
          bucket: string
          hits: number
          updated_at: string
          window_start: string
        }
        Insert: {
          bucket: string
          hits?: number
          updated_at?: string
          window_start: string
        }
        Update: {
          bucket?: string
          hits?: number
          updated_at?: string
          window_start?: string
        }
        Relationships: []
      }
      schema_baseline_snapshots: {
        Row: {
          applied_at: string
          epoch: string
          snapshot: Json
        }
        Insert: {
          applied_at?: string
          epoch: string
          snapshot: Json
        }
        Update: {
          applied_at?: string
          epoch?: string
          snapshot?: Json
        }
        Relationships: []
      }
      schema_drift_log: {
        Row: {
          detail: Json | null
          detected_at: string
          drift_type: string
          event_kind: string
          id: string
          issue_url: string | null
          object_name: string | null
          resolved_at: string | null
        }
        Insert: {
          detail?: Json | null
          detected_at?: string
          drift_type: string
          event_kind?: string
          id?: string
          issue_url?: string | null
          object_name?: string | null
          resolved_at?: string | null
        }
        Update: {
          detail?: Json | null
          detected_at?: string
          drift_type?: string
          event_kind?: string
          id?: string
          issue_url?: string | null
          object_name?: string | null
          resolved_at?: string | null
        }
        Relationships: []
      }
      user_facilities: {
        Row: {
          facility_id: string
          role: string
          user_id: string
        }
        Insert: {
          facility_id: string
          role?: string
          user_id: string
        }
        Update: {
          facility_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_facilities_facility_id_fkey"
            columns: ["facility_id"]
            isOneToOne: false
            referencedRelation: "facilities"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      drift_alert_view: {
        Row: {
          detected_at: string | null
          drift_type: string | null
          id: string | null
          issue_url: string | null
          object_name: string | null
        }
        Insert: {
          detected_at?: string | null
          drift_type?: string | null
          id?: string | null
          issue_url?: string | null
          object_name?: string | null
        }
        Update: {
          detected_at?: string | null
          drift_type?: string | null
          id?: string | null
          issue_url?: string | null
          object_name?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      assert_facility_owns: {
        Args: {
          p_facility_id: string
          p_ids: string[]
          p_kind: string
          p_parent_id?: string
        }
        Returns: undefined
      }
      check_business_invariants: {
        Args: never
        Returns: {
          detail: Json
          invariant_id: string
          object_name: string
        }[]
      }
      check_denial_anomalies: {
        Args: {
          p_lookback_seconds?: number
          p_threshold?: number
          p_window_seconds?: number
        }
        Returns: {
          detail: Json
          hits: number
          subject: string
        }[]
      }
      check_schema_drift: {
        Args: never
        Returns: {
          detail: Json
          drift_type: string
          object_name: string
        }[]
      }
      consume_rate_limit: {
        Args: { p_bucket: string; p_limit: number; p_window_seconds: number }
        Returns: {
          allowed: boolean
          hit_count: number
          limit_value: number
          reset_at: string
        }[]
      }
      create_case_order_atomic: {
        Args: {
          p_case_datetime: string
          p_client_request_id?: string
          p_doctor_name: string
          p_facility_id: string
          p_gender: string
          p_items: Json
          p_patient_id: string
          p_patient_initials: string
          p_procedure_name: string
        }
        Returns: Json
      }
      create_consumable_order_atomic: {
        Args: {
          p_client_request_id?: string
          p_facility_id: string
          p_items: Json
        }
        Returns: Json
      }
      create_loan_order_atomic: {
        Args: {
          p_client_request_id?: string
          p_facility_id: string
          p_items: Json
          p_maker: string
          p_procedure_name: string
        }
        Returns: Json
      }
      create_loan_return_atomic: {
        Args: { p_header: Json; p_items: Json }
        Returns: Json
      }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      get_admin_status: {
        Args: never
        Returns: {
          db_has_admin: boolean
          user_is_admin: boolean
        }[]
      }
      get_distributor_product_price_history: {
        Args: { p_distributor_product_id: string }
        Returns: {
          changed_at: string
          dist_product_id: string
          entity_id: string
          entity_type: string
          facility_name: string
          field_name: string
          id: string
          new_value: number
          old_value: number
        }[]
      }
      get_news_feed: {
        Args: { p_facility_id: string; p_limit?: number; p_offset?: number }
        Returns: {
          distributor_product_id: string
          event_type: string
          facility_name: string
          field_name: string
          id: string
          maker: string
          new_value: number
          occurred_at: string
          old_value: number
          product_name: string
          supplier: string
        }[]
      }
      get_order_amount_report: {
        Args: { p_date_from: string; p_date_to: string }
        Returns: {
          case_order_amount: number
          case_order_count: number
          case_order_total_count: number
          consumable_order_amount: number
          consumable_order_count: number
          consumable_order_total_count: number
          facility_id: string
          facility_name: string
          loan_order_amount: number
          loan_order_count: number
          loan_order_total_count: number
        }[]
      }
      has_aal2: { Args: never; Returns: boolean }
      is_admin: { Args: never; Returns: boolean }
      is_facility_member: { Args: { p_facility_id: string }; Returns: boolean }
      is_facility_writer: { Args: { p_facility_id: string }; Returns: boolean }
      loan_outstanding_count: {
        Args: { p_facility_id: string }
        Returns: number
      }
      rate_limit_bucket_key: {
        Args: {
          p_bucket: string
          p_window_seconds: number
          p_window_start: string
        }
        Returns: string
      }
      rate_limit_window_start: {
        Args: { p_window_seconds: number }
        Returns: string
      }
      record_access_denial: {
        Args: {
          p_actor_id?: string
          p_facility_id?: string
          p_guard: string
          p_method?: string
          p_reason: string
          p_route?: string
        }
        Returns: string
      }
      record_business_invariants: { Args: never; Returns: undefined }
      record_denial_anomalies: {
        Args: {
          p_lookback_seconds?: number
          p_threshold?: number
          p_window_seconds?: number
        }
        Returns: undefined
      }
      record_issue_url: {
        Args: { log_id: string; url: string }
        Returns: undefined
      }
      record_privileged_operation: {
        Args: {
          p_actor_id: string
          p_error_code?: string
          p_method?: string
          p_operation: string
          p_route?: string
          p_succeeded: boolean
          p_target_email?: string
          p_target_user_id?: string
        }
        Returns: string
      }
      record_schema_drift: { Args: never; Returns: undefined }
      refresh_schema_baseline_snapshot: {
        Args: { new_epoch: string }
        Returns: undefined
      }
      refund_rate_limit: {
        Args: { p_bucket: string; p_window_seconds: number }
        Returns: {
          hit_count: number
          refunded: boolean
        }[]
      }
      resolve_denial_anomaly_subject: {
        Args: { p_object_name: string }
        Returns: string
      }
      resolve_jan_unit_price: {
        Args: { p_facility_id: string; p_jan: string }
        Returns: number
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

